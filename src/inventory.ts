/**
 * The filament stock: kinds of filament ("products", keyed by the code printed on the spool) and
 * the spools on the shelf. A product is learned the first time its code is scanned, so every later
 * spool with the same code is recognized right away.
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
}

export interface Spool {
  id: string;
  code: string;
  /** When the spool was added, ms since epoch. */
  added: number;
  opened: boolean;
}

export interface Inventory {
  version: 1;
  products: Record<string, Product>;
  spools: Spool[];
}

export const emptyInventory = (): Inventory => ({ version: 1, products: {}, spools: [] });

export const emptyProduct = (code: string): Product => ({
  code,
  brand: '',
  material: '',
  color: '',
  hex: '',
  weight: 0,
  note: '',
});

/** A product counts as described once its material is known. */
export const isDescribed = (p: Product | undefined): boolean => !!p && p.material.trim() !== '';

let counter = 0;
const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** Adds one spool with this code; the product is created (without details) if it is new. */
export function addSpool(inv: Inventory, code: string, details?: Partial<Product>, now = Date.now()): Spool {
  if (!inv.products[code]) inv.products[code] = { ...emptyProduct(code), ...details, code };
  const spool: Spool = { id: newId(), code, added: now, opened: false };
  inv.spools.push(spool);
  return spool;
}

/**
 * Removes one spool with this code and returns it, or null when there is none. An opened spool
 * goes first (that is the one that just ran empty), otherwise the oldest.
 */
export function removeOneSpool(inv: Inventory, code: string): Spool | null {
  const mine = inv.spools.filter((s) => s.code === code);
  if (mine.length === 0) return null;
  const pick = mine.find((s) => s.opened) ?? mine.reduce((a, b) => (b.added < a.added ? b : a));
  return removeSpoolById(inv, pick.id);
}

export function removeSpoolById(inv: Inventory, id: string): Spool | null {
  const i = inv.spools.findIndex((s) => s.id === id);
  if (i < 0) return null;
  return inv.spools.splice(i, 1)[0];
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
const HEX = /^#[0-9a-f]{6}$/i;

/** Reads a stored or imported inventory, dropping anything malformed. Returns null if unusable. */
export function parseInventory(raw: unknown): Inventory | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { products?: unknown; spools?: unknown };
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
    const added = typeof s.added === 'number' && Number.isFinite(s.added) ? s.added : Date.now();
    inv.spools.push({ id, code, added, opened: s.opened === true });
    if (!inv.products[code]) inv.products[code] = emptyProduct(code);
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
