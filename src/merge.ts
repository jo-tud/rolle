/**
 * Merges two versions of the stock, e.g. this device's and the synced one. Nothing either side
 * added is lost: for each spool and product the newer change wins, and a removal wins over any
 * change made before it. Merging is order-independent and can be repeated without effect, so
 * devices that sync at random times still end up with the same stock.
 */
import { emptyInventory, emptyProduct, type Inventory, type Product, type Spool } from './inventory';

/** Removal notes older than this are dropped; a device offline for longer may bring spools back. */
export const KEEP_DELETED_MS = 365 * 24 * 60 * 60 * 1000;

/** The newer of two versions. A tie is decided by content, so every device picks the same one. */
function newer<T extends { updated: number }>(a: T | undefined, b: T | undefined): T | undefined {
  if (!a || !b) return a ?? b;
  if (a.updated !== b.updated) return b.updated > a.updated ? b : a;
  const text = (x: T) => JSON.stringify(x, Object.keys(x).sort());
  return text(b) > text(a) ? b : a;
}

export function merge(a: Inventory, b: Inventory, now = Date.now()): Inventory {
  const out = emptyInventory();

  for (const src of [a.deleted, b.deleted]) {
    for (const [k, t] of Object.entries(src)) {
      if (now - t > KEEP_DELETED_MS) continue;
      if (!(out.deleted[k] >= t)) out.deleted[k] = t;
    }
  }
  const gone = (key: string, updated: number) => {
    const t = out.deleted[key];
    return t !== undefined && t >= updated;
  };

  for (const code of new Set([...Object.keys(a.products), ...Object.keys(b.products)])) {
    const p = newer<Product>(a.products[code], b.products[code])!;
    if (!gone(`p:${code}`, p.updated)) out.products[code] = { ...p };
  }

  const spools = new Map<string, Spool>();
  for (const s of [...a.spools, ...b.spools]) spools.set(s.id, newer(spools.get(s.id), s)!);
  for (const s of spools.values()) {
    if (gone(`s:${s.id}`, s.updated)) continue;
    out.spools.push({ ...s });
    // A spool added on one device while the other forgot its kind keeps a placeholder kind.
    out.products[s.code] ??= emptyProduct(s.code);
  }
  out.spools.sort((x, y) => x.added - y.added || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return out;
}

/** A stable text form: two inventories with the same content give the same text. */
export function canonical(inv: Inventory): string {
  const sortObj = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  const product = (p: Product) => [p.code, p.brand, p.material, p.color, p.hex, p.weight, p.note, p.updated];
  const spool = (s: Spool) => [s.id, s.code, s.added, s.opened, s.updated, s.tag ?? null];
  return JSON.stringify({
    products: Object.values(sortObj(inv.products)).map(product),
    spools: [...inv.spools].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)).map(spool),
    deleted: sortObj(inv.deleted),
  });
}

export const sameContent = (a: Inventory, b: Inventory): boolean => canonical(a) === canonical(b);
