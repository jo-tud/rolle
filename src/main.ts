import './style.css';
import { parseNfcScan, processNfcScan } from './nfc';
import { startCamera, type CameraScanner } from './camera';
import { detailsOf, loadCatalog, type Catalog, type CatalogEntry } from './catalog';
import { signal } from './feedback';
import { BRANDS, MATERIALS, guessDetails } from './guess';
import {
  STORAGE_KEY,
  addSpool,
  countOf,
  deleteProduct,
  emptyProduct,
  groups,
  isDescribed,
  loadInventory,
  parseInventory,
  productLabel,
  removeOneSpool,
  removeSpoolById,
  restoreProduct,
  restoreSpool,
  saveInventory,
  searchText,
  setOpened,
  setProduct,
  type Inventory,
  type Product,
  type Spool,
} from './inventory';
import { merge } from './merge';
import { initSync, type SyncUi } from './syncUi';
import { listenForScanner } from './wedge';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

// ---- state -------------------------------------------------------------------------------------

let inv: Inventory = loadInventory(storage());
let mode: 'add' | 'remove' = 'add';
let sound = storage()?.getItem('rolle-ton') !== 'off';
let filterText = '';
let filterFamily = '';
const expanded = new Set<string>();
let camera: CameraScanner | null = null;
let syncUi: SyncUi | null = null;
let catalog: Catalog | null = null;

interface Undo {
  label: string;
  run: () => void;
}
const undoStack: Undo[] = [];

function pushUndo(label: string, run: () => void): void {
  undoStack.push({ label, run });
  if (undoStack.length > 50) undoStack.shift();
}

function undo(): void {
  const step = undoStack.pop();
  if (!step) return;
  step.run();
  lastScan.hidden = true;
  commit();
  toast(`Rückgängig: ${step.label}`);
}

let warnedStorage = false;
let askedPersist = false;
/** Saves a local change, shows it and passes it on to the other devices. */
function commit(): void {
  persist();
  syncUi?.changed();
}

function persist(): void {
  const ok = saveInventory(storage(), inv);
  if (!ok && !warnedStorage) {
    warnedStorage = true;
    toast('Achtung: Der Browser speichert nicht (privates Fenster?). Bitte „Sicherung speichern“ nutzen.', 8000);
  }
  if (ok && !askedPersist) {
    askedPersist = true;
    // Asks the browser not to clear the data when space runs low.
    void navigator.storage?.persist?.().catch(() => {});
  }
  render();
}

// ---- helpers -----------------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string>> = {},
  ...children: (Node | string | null | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

function swatch(p: Product | undefined, big = false): HTMLElement {
  const s = el('span', { class: big ? 'swatch big' : 'swatch', 'aria-hidden': 'true' });
  if (p?.hex) s.style.background = p.hex;
  else s.classList.add('none');
  return s;
}

const family = (p: Product): string => {
  if (!isDescribed(p)) return 'Ohne Details';
  const m = /^[A-Za-z0-9]+/.exec(p.material.trim());
  return m ? m[0].toUpperCase() : p.material.trim();
};

const spoolWord = (n: number) => (n === 1 ? '1 Spule' : `${n} Spulen`);
const dateDe = (t: number) => new Date(t).toLocaleDateString('de-DE');

let toastTimer = 0;
const toastEl = $('toast');
function toast(message: string, ms = 4000, action?: { label: string; run: () => void }): void {
  toastEl.replaceChildren(el('span', { text: message }));
  if (action) {
    const b = el('button', { type: 'button', text: action.label });
    b.addEventListener('click', () => {
      toastEl.hidden = true;
      action.run();
    });
    toastEl.append(b);
  }
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), ms);
}

// ---- scanning ----------------------------------------------------------------------------------

const lastScan = $('lastScan');

type LastKind = 'add' | 'new' | 'remove' | 'missing' | 'duplicate';

function showLast(kind: LastKind, code: string): void {
  const p = inv.products[code];
  const n = countOf(inv, code);
  const title = p ? productLabel(p) : 'Unbekannter Code';
  const sub = p?.color || (p && isDescribed(p) ? '' : code);
  const message = {
    add: `Eingelagert · jetzt ${spoolWord(n)}`,
    new: isDescribed(p) ? `Neue Sorte erkannt · ${spoolWord(n)}` : 'Neuer Code – bitte Details eintragen',
    remove: n ? `Ausgebucht · noch ${spoolWord(n)}` : 'Ausgebucht · letzte Spule dieser Sorte',
    missing: 'Nicht im Bestand – nichts ausgebucht',
    duplicate: 'Diese Spule ist schon im Bestand',
  }[kind];

  const actions = el('div', { class: 'last-actions' });
  if (p && (kind === 'new' || !isDescribed(p))) {
    const details = el('button', { type: 'button', class: 'primary', text: 'Details eintragen' });
    details.addEventListener('click', () => openEdit(code));
    actions.append(details);
  }
  if (kind !== 'missing' && kind !== 'duplicate') {
    const back = el('button', { type: 'button', text: 'Rückgängig' });
    back.addEventListener('click', undo);
    actions.append(back);
  }

  lastScan.className = `last ${kind}`;
  lastScan.replaceChildren(
    swatch(p, true),
    el(
      'div',
      { class: 'last-text' },
      el('strong', { text: title }),
      sub ? el('span', { text: sub }) : null,
      el('small', { text: message }),
    ),
    actions,
  );
  lastScan.hidden = false;
  // Restart the flash so every scan is visible, even of the same code.
  lastScan.classList.remove('flash');
  void lastScan.offsetWidth;
  lastScan.classList.add('flash');
}

function handleScan(raw: string): void {
  const code = raw.replace(/[\r\n]+$/g, '').trim();
  if (!code) return;
  // The code for connecting another device is no spool.
  if (syncUi?.handlePairing(code)) {
    stopCamera();
    return;
  }
  if (mode === 'add') {
    const isNew = !inv.products[code];
    const known = isNew ? catalog?.lookup(code) : null;
    // Scanned before the table was loaded: it fills the kind in once it is there.
    if (isNew && !catalog) setTimeout(loadAndFill, 0);
    const spool = addSpool(inv, code, isNew ? { ...guessDetails(code), ...(known ? detailsOf(known) : {}) } : undefined);
    const p = inv.products[code];
    pushUndo(`${productLabel(p)} eingelagert`, () => {
      removeSpoolById(inv, spool.id);
      if (isNew && countOf(inv, code) === 0) deleteProduct(inv, code);
    });
    commit();
    signal(isNew ? 'new' : 'add', sound);
    showLast(isNew ? 'new' : 'add', code);
  } else {
    const removed = removeOneSpool(inv, code);
    if (!removed) {
      signal('error', sound);
      showLast('missing', code);
      return;
    }
    pushUndo(`${productLabel(inv.products[code] ?? emptyProduct(code))} ausgebucht`, () => restoreSpool(inv, removed));
    commit();
    signal('remove', sound);
    showLast('remove', code);
  }
}

// Serialize bridge events so catalog loading cannot race two scans of the same spool.
let nfcQueue = Promise.resolve();
window.addEventListener('rolle:nfc', (event) => {
  const scan = parseNfcScan((event as CustomEvent<unknown>).detail);
  if (!scan) { toast('NFC-Daten konnten nicht gelesen werden'); return; }
  const scanMode = mode;
  nfcQueue = nfcQueue.then(async () => {
    try { catalog ??= await loadCatalog(); } catch { /* Tag details remain usable offline. */ }
    const result = processNfcScan(inv, scan, scanMode, catalog);
    if (result.kind === 'duplicate' || result.kind === 'missing') {
      signal('error', sound);
      showLast(result.kind, result.code);
      return;
    }
    const { code, spool } = result;
    if (result.kind === 'add') {
      pushUndo(`${productLabel(inv.products[code])} eingelagert`, () => {
        removeSpoolById(inv, spool.id);
        if (result.isNew && countOf(inv, code) === 0) deleteProduct(inv, code);
      });
    } else {
      pushUndo(`${productLabel(inv.products[code] ?? emptyProduct(code))} ausgebucht`, () => restoreSpool(inv, spool));
    }
    commit();
    signal(result.kind, sound);
    showLast(result.kind, code);
  }).catch(() => toast('NFC-Scan konnte nicht verarbeitet werden'));
});

function setMode(next: 'add' | 'remove'): void {
  mode = next;
  $('modeAdd').setAttribute('aria-pressed', String(next === 'add'));
  $('modeRemove').setAttribute('aria-pressed', String(next === 'remove'));
  document.body.classList.toggle('removing', next === 'remove');
}

$('modeAdd').addEventListener('click', () => setMode('add'));
$('modeRemove').addEventListener('click', () => setMode('remove'));

const dialog = $<HTMLDialogElement>('editDialog');
listenForScanner(
  (code) => {
    handleScan(code);
    const hint = $('scannerHint');
    hint.classList.remove('flash');
    void hint.offsetWidth;
    hint.classList.add('flash');
  },
  () => !document.querySelector('dialog[open]'),
);

$<HTMLFormElement>('manualForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('manualInput');
  handleScan(input.value);
  input.value = '';
});

// Camera
const cameraBox = $('cameraBox');
const cameraBtn = $('cameraBtn');
async function toggleCamera(): Promise<void> {
  if (camera) return stopCamera();
  cameraBox.hidden = false;
  cameraBtn.textContent = '⏳ Kamera startet …';
  try {
    camera = await startCamera($<HTMLVideoElement>('video'), handleScan);
    cameraBtn.textContent = '■ Kamera aus';
    cameraBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (err) {
    cameraBox.hidden = true;
    cameraBtn.textContent = '📷 Kamera-Scan';
    const name = (err as { name?: string })?.name;
    const why =
      name === 'NotAllowedError'
        ? 'Zugriff verweigert – bitte in den Browser-Einstellungen erlauben.'
        : name === 'NotFoundError'
          ? 'Keine Kamera gefunden.'
          : !window.isSecureContext
            ? 'Die Kamera geht nur über https.'
            : 'Kamera nicht verfügbar.';
    toast(why, 6000);
  }
}
function stopCamera(): void {
  camera?.stop();
  camera = null;
  cameraBox.hidden = true;
  cameraBtn.textContent = '📷 Kamera-Scan';
}
cameraBtn.addEventListener('click', () => void toggleCamera());
$('cameraStop').addEventListener('click', stopCamera);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera();
});

const soundBtn = $('soundBtn');
function showSound(): void {
  soundBtn.textContent = sound ? '🔊' : '🔇';
  soundBtn.setAttribute('aria-pressed', String(sound));
}
soundBtn.addEventListener('click', () => {
  sound = !sound;
  try {
    storage()?.setItem('rolle-ton', sound ? 'on' : 'off');
  } catch {
    // Only a preference.
  }
  showSound();
  if (sound) signal('add', true);
});
showSound();

// ---- stock list --------------------------------------------------------------------------------

$<HTMLInputElement>('search').addEventListener('input', (e) => {
  filterText = (e.target as HTMLInputElement).value.trim().toLowerCase();
  render();
});
// Enter leaves the search box, so the next scanner burst counts as a scan again.
$<HTMLInputElement>('search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
});

function spoolRow(s: Spool, i: number): HTMLElement {
  const opened = el('input', { type: 'checkbox' });
  opened.checked = s.opened;
  opened.addEventListener('change', () => {
    setOpened(s, opened.checked);
    commit();
  });
  const out = el('button', { type: 'button', class: 'small', text: 'Ausbuchen' });
  out.addEventListener('click', () => {
    const removed = removeSpoolById(inv, s.id);
    if (!removed) return;
    const label = productLabel(inv.products[s.code] ?? emptyProduct(s.code));
    pushUndo(`${label} ausgebucht`, () => restoreSpool(inv, removed));
    commit();
    toast(`${label} ausgebucht`, 5000, { label: 'Rückgängig', run: undo });
  });
  return el(
    'li',
    {},
    el('span', { class: 'spool-name', text: `Spule ${i + 1} · seit ${dateDe(s.added)}` }),
    el('label', { class: 'check' }, opened, 'angebrochen'),
    out,
  );
}

function groupCard(product: Product, spools: Spool[]): HTMLElement {
  const code = product.code;
  const open = expanded.has(code);
  const opened = spools.filter((s) => s.opened).length;
  const card = el('article', { class: `group${isDescribed(product) ? '' : ' unknown'}${open ? ' open' : ''}` });

  // The material leads (it is what one looks for); the brand follows the color in the second line.
  const title = product.material.trim() || 'Unbekanntes Filament';
  const sub = [product.color, product.brand, opened ? `${opened} angebrochen` : '', product.note].filter(Boolean).join(' · ');
  const main = el(
    'button',
    { type: 'button', class: 'group-main', 'aria-expanded': String(open) },
    swatch(product),
    el(
      'span',
      { class: 'group-text' },
      el('strong', { text: title }),
      el('span', { class: 'muted', text: isDescribed(product) ? sub : 'Details fehlen' }),
    ),
  );
  main.addEventListener('click', () => {
    if (open) expanded.delete(code);
    else expanded.add(code);
    render();
  });

  const minus = el('button', { type: 'button', class: 'step', 'aria-label': 'Eine Spule ausbuchen', text: '−' });
  minus.addEventListener('click', () => {
    const removed = removeOneSpool(inv, code);
    if (!removed) return;
    pushUndo(`${productLabel(product)} ausgebucht`, () => restoreSpool(inv, removed));
    commit();
    toast(`${productLabel(product)} ausgebucht`, 5000, { label: 'Rückgängig', run: undo });
  });
  const plus = el('button', { type: 'button', class: 'step', 'aria-label': 'Eine Spule dazu', text: '+' });
  plus.addEventListener('click', () => {
    const s = addSpool(inv, code);
    pushUndo(`${productLabel(product)} eingelagert`, () => removeSpoolById(inv, s.id));
    commit();
  });
  const edit = el('button', { type: 'button', class: 'step edit', 'aria-label': 'Details bearbeiten', text: '✎' });
  edit.addEventListener('click', () => openEdit(code));

  card.append(
    el(
      'div',
      { class: 'group-head' },
      main,
      el('div', { class: 'group-count' }, minus, el('span', { class: 'count', text: String(spools.length) }), plus, edit),
    ),
  );
  if (open) card.append(el('ol', { class: 'spools' }, ...spools.map(spoolRow)));
  return card;
}

function render(): void {
  const all = groups(inv);
  const total = inv.spools.length;
  $('summary').textContent = total
    ? `${spoolWord(total)} · ${all.length === 1 ? '1 Sorte' : `${all.length} Sorten`}`
    : 'Noch leer';

  // Material chips
  const families = new Map<string, number>();
  for (const g of all) families.set(family(g.product), (families.get(family(g.product)) ?? 0) + g.spools.length);
  if (filterFamily && !families.has(filterFamily)) filterFamily = '';
  const chips = $('chips');
  chips.replaceChildren();
  if (families.size > 1) {
    const chip = (name: string, label: string) => {
      const b = el('button', { type: 'button', class: 'chip', 'aria-pressed': String(filterFamily === name), text: label });
      b.addEventListener('click', () => {
        filterFamily = filterFamily === name ? '' : name;
        render();
      });
      return b;
    };
    chips.append(chip('', `Alle ${total}`));
    for (const [name, n] of [...families].sort((a, b) => a[0].localeCompare(b[0], 'de'))) chips.append(chip(name, `${name} ${n}`));
  }

  const shown = all.filter(
    (g) => (!filterFamily || family(g.product) === filterFamily) && (!filterText || searchText(g.product).includes(filterText)),
  );
  $('groups').replaceChildren(...shown.map((g) => groupCard(g.product, g.spools)));
  const empty = $('empty');
  empty.hidden = shown.length > 0;
  empty.textContent = total
    ? 'Nichts gefunden.'
    : 'Noch keine Filamente. Scanne den QR-Code einer Spule – mit dem Hand-Scanner oder der Kamera.';

  const missing = all.filter((g) => !isDescribed(g.product));
  const banner = $('missing');
  banner.hidden = missing.length === 0;
  banner.textContent =
    missing.length === 1 ? '1 Sorte ohne Details – jetzt eintragen ›' : `${missing.length} Sorten ohne Details – jetzt eintragen ›`;
  banner.onclick = () => missing[0] && openEdit(missing[0].product.code);
}

// ---- edit dialog -------------------------------------------------------------------------------

const f = {
  brand: $<HTMLInputElement>('fBrand'),
  material: $<HTMLInputElement>('fMaterial'),
  color: $<HTMLInputElement>('fColor'),
  hex: $<HTMLInputElement>('fHex'),
  weight: $<HTMLInputElement>('fWeight'),
  count: $<HTMLInputElement>('fCount'),
  note: $<HTMLInputElement>('fNote'),
};
let editing: { code: string; create: boolean; hexSet: boolean } | null = null;

const fill = (list: string, values: string[]) =>
  $(list).replaceChildren(...values.map((v) => el('option', { value: v })));
fill('brandList', BRANDS);
fill('materialList', MATERIALS);

function openEdit(code: string, create = false): void {
  const p = inv.products[code] ?? { ...emptyProduct(code), ...(create ? { brand: 'Bambu Lab', weight: 1000 } : {}) };
  editing = { code, create, hexSet: !!p.hex };
  $('editTitle').textContent = create ? 'Spule ohne Code anlegen' : isDescribed(p) ? 'Filament bearbeiten' : 'Neues Filament';
  f.brand.value = p.brand || (isDescribed(p) ? '' : 'Bambu Lab');
  f.material.value = p.material;
  f.color.value = p.color;
  f.hex.value = p.hex || '#808080';
  f.hex.classList.toggle('unset', !p.hex);
  f.weight.value = p.weight ? String(p.weight) : '';
  f.note.value = p.note;
  f.count.value = '1';
  $('fCountWrap').hidden = !create;
  $('fCode').textContent = create ? '– (keiner)' : code;
  $('fDelete').hidden = create || !inv.products[code];
  // Colors already used are offered first, then the common ones.
  const used = [...new Set(Object.values(inv.products).map((x) => x.color).filter(Boolean))];
  fill('colorList', [...used, ...['Schwarz', 'Weiß', 'Grau', 'Rot', 'Blau', 'Grün', 'Gelb', 'Orange'].filter((c) => !used.includes(c))]);
  fSearch.value = '';
  fResults.replaceChildren();
  dialog.showModal();
  (p.material ? f.color : fSearch).focus();
}

f.hex.addEventListener('input', () => {
  if (editing) editing.hexSet = true;
  f.hex.classList.remove('unset');
});
$('fHexClear').addEventListener('click', () => {
  if (editing) editing.hexSet = false;
  f.hex.classList.add('unset');
});
$('fCancel').addEventListener('click', () => dialog.close());

// Catalog search: pick brand, material and color in one go.
const fSearch = $<HTMLInputElement>('fSearch');
const fResults = $('fResults');
function pickFromCatalog(e: CatalogEntry): void {
  f.brand.value = e.brand;
  f.material.value = e.material;
  f.color.value = e.color;
  if (e.hex) {
    f.hex.value = e.hex;
    f.hex.classList.remove('unset');
    if (editing) editing.hexSet = true;
  }
  if (e.weight) f.weight.value = String(e.weight);
  fSearch.value = '';
  fResults.replaceChildren();
}
fSearch.addEventListener('input', async () => {
  const query = fSearch.value;
  const cat = await loadCatalog();
  if (query !== fSearch.value) return;
  const hits = cat.search(query, 12);
  fResults.replaceChildren(
    ...hits.map((e) => {
      const b = el(
        'button',
        { type: 'button', class: 'result' },
        swatch({ ...emptyProduct(''), hex: e.hex }),
        el('span', {}, el('strong', { text: `${e.material} · ${e.color}` }), el('small', { class: 'muted', text: e.brand })),
      );
      b.addEventListener('click', () => pickFromCatalog(e));
      return b;
    }),
  );
  if (query.trim() && hits.length === 0) fResults.append(el('p', { class: 'muted', text: 'Nichts gefunden – trag die Angaben unten selbst ein.' }));
});
// Enter in the search box picks the first hit instead of saving the form.
fSearch.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  (fResults.querySelector('button.result') as HTMLButtonElement | null)?.click();
});

$<HTMLFormElement>('editForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!editing) return;
  const { code, create, hexSet } = editing;
  const before = inv.products[code] ? { ...inv.products[code] } : null;
  const weight = Math.round(Number(f.weight.value));
  const next: Product = {
    code,
    brand: f.brand.value.trim(),
    material: f.material.value.trim(),
    color: f.color.value.trim(),
    hex: hexSet ? f.hex.value.toLowerCase() : '',
    weight: Number.isFinite(weight) && weight > 0 ? weight : 0,
    note: f.note.value.trim(),
    updated: Date.now(),
  };
  setProduct(inv, next);
  const added: string[] = [];
  if (create) {
    const n = Math.min(99, Math.max(1, Math.round(Number(f.count.value)) || 1));
    for (let i = 0; i < n; i++) added.push(addSpool(inv, code).id);
  }
  pushUndo(create ? `${productLabel(next)} angelegt` : `${productLabel(next)} geändert`, () => {
    for (const id of added) removeSpoolById(inv, id);
    if (before) setProduct(inv, before);
    else deleteProduct(inv, code);
  });
  dialog.close();
  commit();
  if (!lastScan.hidden && lastScan.querySelector('.last-actions .primary')) showLast('add', code);
});

$('fDelete').addEventListener('click', () => {
  if (!editing) return;
  const { code } = editing;
  const p = inv.products[code];
  if (!confirm(`„${productLabel(p)}${p.color ? ' ' + p.color : ''}“ mit ${spoolWord(countOf(inv, code))} löschen? Die App vergisst dann auch den Code.`)) return;
  const removed = deleteProduct(inv, code);
  expanded.delete(code);
  pushUndo(`${productLabel(p)} gelöscht`, () => restoreProduct(inv, removed.product, removed.spools));
  dialog.close();
  commit();
  toast(`${productLabel(p)} gelöscht`, 6000, { label: 'Rückgängig', run: undo });
});

$('addManual').addEventListener('click', () => {
  const id = globalThis.crypto?.randomUUID?.() ?? String(Date.now());
  openEdit(`ohne-code:${id}`, true);
});

// ---- backup ------------------------------------------------------------------------------------

$('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(inv, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `rolle-sicherung-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$<HTMLInputElement>('importInput').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  let next: Inventory | null = null;
  try {
    next = parseInventory(JSON.parse(await file.text()));
  } catch {
    next = null;
  }
  if (!next) {
    toast('Die Datei ist keine Sicherung dieser App.', 6000);
    return;
  }
  // Merging keeps whatever was added since the backup; what was removed since stays removed.
  if (!confirm(`Sicherung mit ${spoolWord(next.spools.length)} einspielen? Spulen aus der Sicherung, die hier fehlen, kommen dazu.`)) return;
  inv = merge(inv, next);
  undoStack.length = 0;
  commit();
  toast('Sicherung eingespielt', 5000);
});

// Another tab of the app changed the stock.
window.addEventListener('storage', (e) => {
  if (e.key !== STORAGE_KEY) return;
  inv = loadInventory(storage());
  undoStack.length = 0;
  render();
});

syncUi = initSync({
  local: {
    get: () => inv,
    apply(merged) {
      inv = merge(inv, merged);
      persist();
    },
  },
  getInventory: () => inv,
  toast,
  scanPairing() {
    if (!camera) void toggleCamera();
    toast('Halte den Code vom anderen Gerät in die Kamera.', 6000);
  },
});

// Opened through a pairing link: take it in and drop it from the address bar.
if (location.hash.includes('verbinden=')) {
  const link = location.hash;
  history.replaceState(null, '', location.pathname + location.search);
  syncUi.handlePairing(link);
}

render();

// Known barcodes: fill in kinds scanned before the catalog was there (or loaded).
function fillFromCatalog(c: Catalog): void {
  catalog = c;
  let filled = 0;
  for (const p of Object.values(inv.products)) {
    if (isDescribed(p)) continue;
    const hit = c.lookup(p.code);
    if (!hit) continue;
    setProduct(inv, { ...p, ...detailsOf(hit), note: p.note || detailsOf(hit).note || '' });
    filled++;
  }
  if (filled) {
    commit();
    toast(filled === 1 ? '1 Sorte am Barcode erkannt und ergänzt.' : `${filled} Sorten am Barcode erkannt und ergänzt.`, 6000);
  }
}
function loadAndFill(): void {
  loadCatalog()
    .then(fillFromCatalog)
    .catch(() => {
      // Without the table, codes are simply learned by hand.
    });
}
loadAndFill();

(window as Window & { RolleNfcReady?: boolean }).RolleNfcReady = true;
