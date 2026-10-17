/** The sync dialog: setting a device up, pairing another one, and showing how the sync is doing. */
import qrcode from 'qrcode-generator';
import { toBase64 } from './crypto';
import type { Inventory } from './inventory';
import { merge } from './merge';
import {
  GistApi,
  MESSAGES,
  SyncEngine,
  SyncError,
  TOKEN_URL,
  createVault,
  pairingLink,
  parsePairing,
  probe,
  recreateVault,
  unlock,
  type Envelope,
  type LocalStock,
  type SyncConfig,
  type SyncState,
} from './sync';

const CONFIG_KEY = 'rolle-sync';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function loadConfig(): SyncConfig | null {
  try {
    const v = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? 'null') as Partial<SyncConfig> | null;
    if (v && v.token && v.gistId && v.key && v.salt && Number(v.iterations) > 0) return v as SyncConfig;
  } catch {
    // No usable setup.
  }
  return null;
}

function saveConfig(cfg: SyncConfig | null): void {
  try {
    if (cfg) localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
    else localStorage.removeItem(CONFIG_KEY);
  } catch {
    // Without storage the setup lasts until the page is closed.
  }
}

/** A QR code as SVG, drawn from the module grid (no HTML strings involved). */
function qrSvg(text: string): SVGSVGElement {
  const qr = qrcode(0, 'L');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `-4 -4 ${n + 8} ${n + 8}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  const bg = document.createElementNS(NS, 'rect');
  for (const [k, v] of Object.entries({ x: '-4', y: '-4', width: String(n + 8), height: String(n + 8), fill: '#fff' })) bg.setAttribute(k, v);
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000');
  svg.append(bg, path);
  return svg;
}

function ago(t: number): string {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'gerade eben';
  const m = Math.round(s / 60);
  if (m < 60) return `vor ${m} Min.`;
  return `um ${new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
}

export interface SyncUi {
  /** Call after every local change. */
  changed(): void;
  /** Handles a scanned or opened pairing link; false when the text is no such link. */
  handlePairing(text: string): boolean;
}

export function initSync(opts: {
  local: LocalStock;
  toast: (message: string, ms?: number) => void;
  /** Starts the camera so a pairing code can be scanned. */
  scanPairing: () => void;
  getInventory: () => Inventory;
}): SyncUi {
  const dialog = $<HTMLDialogElement>('syncDialog');
  const btn = $('syncBtn');
  let config = loadConfig();
  let engine: SyncEngine | null = null;
  let state: SyncState | null = null;
  /** Setup in progress: the checked token and what was found in GitHub. */
  let pending: { api: GistApi; token: string; login: string; gistId: string | null; envelope: Envelope | null } | null = null;

  $<HTMLAnchorElement>('tokenLink').href = TOKEN_URL;
  $<HTMLAnchorElement>('tokenLink2').href = TOKEN_URL;

  const showError = (id: string, err: unknown) => {
    const box = $(id);
    box.textContent = err instanceof SyncError ? err.message : MESSAGES.other;
    box.hidden = false;
  };
  const busy = (button: HTMLButtonElement, label: string | null) => {
    button.disabled = label !== null;
    if (label !== null) {
      button.dataset.label ??= button.textContent ?? '';
      button.textContent = label;
    } else if (button.dataset.label !== undefined) {
      button.textContent = button.dataset.label;
      delete button.dataset.label;
    }
  };

  function view(which: 'setup' | 'password' | 'on'): void {
    $('syncSetup').hidden = which !== 'setup';
    $('syncPasswordForm').hidden = which !== 'password';
    $('syncOn').hidden = which !== 'on';
  }

  function renderStatus(): void {
    btn.classList.toggle('on', !!config);
    btn.classList.toggle('busy', state?.phase === 'syncing');
    btn.classList.toggle('bad', state?.phase === 'error' && state.error.kind !== 'offline');
    btn.classList.toggle('offline', state?.phase === 'error' && state.error.kind === 'offline');
    if (!config) return;
    const status = $('syncStatus');
    const who = config.login ? ` als ${config.login}` : '';
    if (!state || state.phase === 'syncing') status.textContent = `Verbunden${who}. Gleiche ab …`;
    else if (state.phase === 'ok') status.textContent = `Verbunden${who}. Abgeglichen ${ago(state.at)}.`;
    else status.textContent = `${state.error.message}${state.at ? ` Zuletzt abgeglichen ${ago(state.at)}.` : ''}`;
    status.className = `sync-status ${state?.phase === 'error' ? (state.error.kind === 'offline' ? 'warn' : 'error') : ''}`;

    const kind = state?.phase === 'error' ? state.error.kind : null;
    const fix = $('syncFix');
    fix.hidden = kind !== 'token' && kind !== 'scope' && kind !== 'missing';
    $('syncFixToken').hidden = kind === 'missing';
    $('syncFixText').textContent =
      kind === 'missing'
        ? 'Die Ablage in GitHub fehlt. Rolle kann sie mit dem Bestand dieses Geräts neu anlegen (gleiches Kennwort).'
        : 'Erstelle bei GitHub einen neuen Zugangsschlüssel mit dem Häkchen „gist“ und füge ihn hier ein.';
    $('syncFixGo').textContent = kind === 'missing' ? 'Neu anlegen' : 'Übernehmen';
    $<HTMLAnchorElement>('gistLink').href = `https://gist.github.com/${config.login ? `${config.login}/` : ''}${config.gistId}`;
  }

  function start(cfg: SyncConfig): void {
    engine?.stop();
    config = cfg;
    saveConfig(cfg);
    engine = new SyncEngine(cfg, new GistApi(cfg.token), opts.local, (s) => {
      state = s;
      renderStatus();
    });
    renderStatus();
    void engine.sync();
  }

  function stop(): void {
    engine?.stop();
    engine = null;
    config = null;
    state = null;
    saveConfig(null);
    renderStatus();
  }

  function open(): void {
    $('syncTokenError').hidden = true;
    $('pairBox').hidden = true;
    view(config ? 'on' : pending ? 'password' : 'setup');
    renderStatus();
    if (!dialog.open) dialog.showModal();
  }

  function askPassword(): void {
    const isNew = !pending?.envelope;
    $('syncPasswordIntro').textContent = isNew
      ? `Angemeldet als ${pending?.login}. Lege ein Kennwort fest, mit dem dein Bestand verschlüsselt wird. Merke es dir gut – ohne es kann niemand die Daten lesen, auch du nicht.`
      : `Angemeldet als ${pending?.login}. Gib das Kennwort ein, das du beim Einrichten festgelegt hast.`;
    const pw = $<HTMLInputElement>('syncPassword');
    pw.value = '';
    pw.minLength = isNew ? 8 : 0;
    pw.autocomplete = isNew ? 'new-password' : 'current-password';
    $('syncPassword2Wrap').hidden = !isNew;
    $<HTMLInputElement>('syncPassword2').value = '';
    $<HTMLInputElement>('syncPassword2').required = isNew;
    $('syncPasswordError').hidden = true;
    $('syncConnect').textContent = isNew ? 'Einrichten' : 'Verbinden';
    view('password');
    if (!dialog.open) dialog.showModal();
    pw.focus();
  }

  async function begin(token: string, gistId?: string): Promise<void> {
    const api = new GistApi(token);
    const found = await probe(api, gistId);
    pending = { api, token, ...found };
    askPassword();
  }

  // ---- events ----

  btn.addEventListener('click', open);
  $('syncClose').addEventListener('click', () => dialog.close());
  $('syncScan').addEventListener('click', () => {
    dialog.close();
    opts.scanPairing();
  });

  $<HTMLFormElement>('syncTokenForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('syncToken');
    const go = $<HTMLButtonElement>('syncTokenGo');
    $('syncTokenError').hidden = true;
    // A pasted pairing link works here too.
    const pairing = parsePairing(input.value.trim());
    busy(go, 'Prüfe …');
    try {
      await begin(pairing?.token ?? input.value.trim(), pairing?.gistId);
      input.value = '';
    } catch (err) {
      showError('syncTokenError', err);
    } finally {
      busy(go, null);
    }
  });

  $('syncBack').addEventListener('click', () => {
    pending = null;
    view('setup');
  });

  $<HTMLFormElement>('syncPasswordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!pending) return;
    const pw = $<HTMLInputElement>('syncPassword').value;
    const go = $<HTMLButtonElement>('syncConnect');
    $('syncPasswordError').hidden = true;
    if (!pending.envelope && pw !== $<HTMLInputElement>('syncPassword2').value) {
      $('syncPasswordError').textContent = 'Die beiden Kennwörter sind verschieden.';
      $('syncPasswordError').hidden = false;
      return;
    }
    busy(go, 'Schlüssel wird berechnet …');
    try {
      const { api, token, login } = pending;
      let cfg: SyncConfig;
      if (pending.envelope && pending.gistId) {
        const { key, remote } = await unlock(pending.envelope, pw);
        // The stock already on this device joins the synced one.
        opts.local.apply(merge(opts.getInventory(), remote));
        const { salt, iterations } = pending.envelope.kdf;
        cfg = { token, gistId: pending.gistId, login, key: toBase64(key), salt, iterations };
      } else {
        const v = await createVault(api, pw, opts.getInventory());
        cfg = { token, gistId: v.gistId, login, key: toBase64(v.key), salt: v.salt, iterations: v.iterations };
      }
      pending = null;
      start(cfg);
      view('on');
      opts.toast('Verbunden – dein Bestand wird jetzt abgeglichen.');
    } catch (err) {
      showError('syncPasswordError', err);
    } finally {
      busy(go, null);
    }
  });

  $('syncNow').addEventListener('click', () => void engine?.sync());

  $('syncPair').addEventListener('click', () => {
    if (!config) return;
    const box = $('pairBox');
    box.hidden = !box.hidden;
    if (!box.hidden) $('pairQr').replaceChildren(qrSvg(pairingLink(location.href, config)));
  });
  $('pairCopy').addEventListener('click', async () => {
    if (!config) return;
    try {
      await navigator.clipboard.writeText(pairingLink(location.href, config));
      opts.toast('Link kopiert. Auf dem anderen Gerät öffnen oder bei ☁ einfügen.');
    } catch {
      opts.toast('Kopieren nicht möglich – bitte den QR-Code scannen.');
    }
  });

  $<HTMLFormElement>('syncFix').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!config || state?.phase !== 'error') return;
    const go = $<HTMLButtonElement>('syncFixGo');
    busy(go, 'Moment …');
    try {
      if (state.error.kind === 'missing') {
        const gistId = await recreateVault(new GistApi(config.token), config, opts.getInventory());
        start({ ...config, gistId });
      } else {
        const token = $<HTMLInputElement>('syncNewToken').value.trim();
        const login = await new GistApi(token).login();
        $<HTMLInputElement>('syncNewToken').value = '';
        start({ ...config, token, login });
      }
    } catch (err) {
      state = { phase: 'error', error: err instanceof SyncError ? err : new SyncError('other', MESSAGES.other), at: null };
      renderStatus();
    } finally {
      busy(go, null);
    }
  });

  $('syncOff').addEventListener('click', () => {
    if (!confirm('Dieses Gerät trennen? Der Bestand bleibt hier und in GitHub erhalten, wird aber nicht mehr abgeglichen.')) return;
    stop();
    view('setup');
  });

  // Keep in step: when the page comes back, the network returns, and once a minute while open.
  const syncIfVisible = () => {
    if (engine && document.visibilityState === 'visible') void engine.sync();
  };
  document.addEventListener('visibilitychange', syncIfVisible);
  window.addEventListener('online', syncIfVisible);
  setInterval(syncIfVisible, 60_000);
  setInterval(() => dialog.open && renderStatus(), 15_000);

  if (config) start(config);
  else renderStatus();

  return {
    changed() {
      engine?.soon();
    },
    handlePairing(text: string): boolean {
      const pairing = parsePairing(text);
      if (!pairing) return false;
      if (config?.gistId === pairing.gistId) {
        opts.toast('Dieses Gerät ist schon verbunden.');
        return true;
      }
      if (config && !confirm('Dieses Gerät ist schon mit einer anderen Ablage verbunden. Wechseln?')) return true;
      if (config) stop();
      pending = null;
      view('setup');
      $('syncTokenError').hidden = true;
      if (!dialog.open) dialog.showModal();
      const go = $<HTMLButtonElement>('syncTokenGo');
      busy(go, 'Prüfe …');
      begin(pairing.token, pairing.gistId)
        .catch((err) => showError('syncTokenError', err))
        .finally(() => busy(go, null));
      return true;
    },
  };
}
