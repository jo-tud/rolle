/**
 * The filament stock: kinds of filament ("products", keyed by the code printed on the spool) and
 * the spools on the shelf. A product is learned the first time its code is scanned, so every later
 * spool with the same code is recognized right away.
 *
 * Every change carries a time stamp and removals leave a note behind (`deleted`), so two devices
 * that changed the stock independently can be merged without losing anything (see merge.ts).
 */

export interface Product {
  code: string;
  brand: string;
  material: string;
  color: string;
  /** #rrggbb, or '' when unknown. */
  hex: string;
  /** Net weight of a full spool in grams, 0 when unknown. */
  weight: number;
  note: string;
  /** Last change, ms since epoch. */
  updated: number;
}

export interface Spool {
  /** Shared identity of both RFID tags on a spool. */
  tag?: string;
  id: string;
  code: string;
  /** When the spool was added, ms since epoch. */
  added: number;
  opened: boolean;
  /** Last change, ms since epoch. */
  updated: number;
}

export interface Inventory {
  version: 1;
  products: Record<string, Product>;
  spools: Spool[];
  /** When something was removed: `s:<spool id>` and `p:<product code>`, ms since epoch. */
  deleted: Record<string, number>;
}

export const emptyInventory = (): Inventory => ({ version: 1, products: {}, spools: [], deleted: {} });

export const emptyProduct = (code: string, updated = 0): Product => ({
  code,
  brand: '',
  material: '',
  color: '',
  hex: '',
  weight: 0,
  note: '',
  updated,
});

/** A product counts as described once its material is known. */
export const isDescribed = (p: Product | undefined): boolean => !!p && p.material.trim() !== '';

let counter = 0;
export const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** Adds one spool with this code; the product is created (without details) if it is new. */
export function addSpool(inv: Inventory, code: string, details?: Partial<Product>, now = Date.now()): Spool {
  if (!inv.products[code]) {
    inv.products[code] = { ...emptyProduct(code), ...details, code, updated: now };
    delete inv.deleted[`p:${code}`];
  }
  const spool: Spool = { id: newId(), code, added: now, opened: false, updated: now };
  inv.spools.push(spool);
  return spool;
}

export function removeSpoolById(inv: Inventory, id: string, now = Date.now()): Spool | null {
  const i = inv.spools.findIndex((s) => s.id === id);
  if (i < 0) return null;
  inv.deleted[`s:${id}`] = now;
  return inv.spools.splice(i, 1)[0];
}

/**
 * Removes one spool with this code and returns it, or null when there is none. An opened spool
 * goes first (that is the one that just ran empty), otherwise the oldest.
 */
export function removeOneSpool(inv: Inventory, code: string, now = Date.now()): Spool | null {
  const mine = inv.spools.filter((s) => s.code === code);
  if (mine.length === 0) return null;
  const pick = mine.find((s) => s.opened) ?? mine.reduce((a, b) => (b.added < a.added ? b : a));
  return removeSpoolById(inv, pick.id, now);
}

/** Puts a removed spool back (undo). */
export function restoreSpool(inv: Inventory, spool: Spool, now = Date.now()): void {
  delete inv.deleted[`s:${spool.id}`];
  if (!inv.spools.some((s) => s.id === spool.id)) inv.spools.push({ ...spool, updated: now });
}

export function setOpened(spool: Spool, opened: boolean, now = Date.now()): void {
  spool.opened = opened;
  spool.updated = now;
}

export function setProduct(inv: Inventory, product: Product, now = Date.now()): void {
  inv.products[product.code] = { ...product, updated: now };
  delete inv.deleted[`p:${product.code}`];
}

/** Forgets a product and its spools. Returns what was removed, for undo. */
export function deleteProduct(inv: Inventory, code: string, now = Date.now()): { product?: Product; spools: Spool[] } {
  const product = inv.products[code];
  const spools = inv.spools.filter((s) => s.code === code);
  for (const s of spools) inv.deleted[`s:${s.id}`] = now;
  inv.spools = inv.spools.filter((s) => s.code !== code);
  delete inv.products[code];
  inv.deleted[`p:${code}`] = now;
  return { product, spools };
}

export function restoreProduct(inv: Inventory, product: Product | undefined, spools: Spool[], now = Date.now()): void {
  if (product) setProduct(inv, product, now);
  for (const s of spools) restoreSpool(inv, s, now);
}

export const countOf = (inv: Inventory, code: string): number =>
  inv.spools.reduce((n, s) => n + (s.code === code ? 1 : 0), 0);

export interface Group {
  product: Product;
  spools: Spool[];
}

export const productLabel = (p: Product): string =>
  [p.brand, p.material].map((s) => s.trim()).filter(Boolean).join(' ') || 'Unbekanntes Filament';

/**
 * Products that have at least one spool, sorted by material, then color. Products without details
 * come first so they get filled in.
 */
export function groups(inv: Inventory): Group[] {
  const byCode = new Map<string, Spool[]>();
  for (const s of inv.spools) {
    const list = byCode.get(s.code);
    if (list) list.push(s);
    else byCode.set(s.code, [s]);
  }
  const out: Group[] = [];
  for (const [code, spools] of byCode) {
    const product = inv.products[code] ?? emptyProduct(code);
    spools.sort((a, b) => a.added - b.added);
    out.push({ product, spools });
  }
  const key = (g: Group) =>
    `${isDescribed(g.product) ? 1 : 0}\u0000${g.product.material.toLowerCase()}\u0000${g.product.color.toLowerCase()}\u0000${g.product.brand.toLowerCase()}`;
  return out.sort((a, b) => key(a).localeCompare(key(b), 'de'));
}

/** Text the search box matches against. */
export const searchText = (p: Product): string =>
  [p.brand, p.material, p.color, p.note, p.code].join(' ').toLowerCase();

// ---- persistence -------------------------------------------------------------------------------

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const time = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const HEX = /^#[0-9a-f]{6}$/i;

/** Reads a stored, synced or imported inventory, dropping anything malformed. Null if unusable. */
export function parseInventory(raw: unknown): Inventory | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { products?: unknown; spools?: unknown; deleted?: unknown };
  if (!r.products || typeof r.products !== 'object' || !Array.isArray(r.spools)) return null;
  const inv = emptyInventory();
  for (const [code, v] of Object.entries(r.products as Record<string, unknown>)) {
    if (!code || !v || typeof v !== 'object') continue;
    const p = v as Record<string, unknown>;
    const hex = str(p.hex);
    const weight = typeof p.weight === 'number' && Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 0;
    inv.products[code] = {
      code,
      brand: str(p.brand),
      material: str(p.material),
      color: str(p.color),
      hex: HEX.test(hex) ? hex.toLowerCase() : '',
      weight,
      note: str(p.note),
      updated: time(p.updated, 0),
    };
  }
  const ids = new Set<string>();
  for (const v of r.spools) {
    if (!v || typeof v !== 'object') continue;
    const s = v as Record<string, unknown>;
    const code = str(s.code);
    if (!code) continue;
    let id = str(s.id);
    if (!id || ids.has(id)) id = newId();
    ids.add(id);
    const added = time(s.added, Date.now());
    const tag = str(s.tag).trim();
    inv.spools.push({ id, code, added, opened: s.opened === true, updated: time(s.updated, added), ...(tag ? { tag } : {}) });
    if (!inv.products[code]) inv.products[code] = emptyProduct(code);
  }
  if (r.deleted && typeof r.deleted === 'object') {
    for (const [k, v] of Object.entries(r.deleted as Record<string, unknown>)) {
      if (/^[sp]:./.test(k) && typeof v === 'number' && Number.isFinite(v)) inv.deleted[k] = v;
    }
  }
  return inv;
}

export const STORAGE_KEY = 'rolle-bestand';

export function loadInventory(storage: Pick<Storage, 'getItem'> | undefined): Inventory {
  try {
    const text = storage?.getItem(STORAGE_KEY);
    if (text) return parseInventory(JSON.parse(text)) ?? emptyInventory();
  } catch {
    // Unreadable storage: start empty rather than not at all.
  }
  return emptyInventory();
}

export function saveInventory(storage: Pick<Storage, 'setItem'> | undefined, inv: Inventory): boolean {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(inv));
    return !!storage;
  } catch {
    return false;
  }
}
