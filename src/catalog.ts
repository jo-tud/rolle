/**
 * Known filaments from the Open Filament Database (MIT): barcode (EAN/GTIN) to brand, material,
 * color and color value, plus all Bambu Lab colors for searching. Built by
 * scripts/build-catalog.mjs into catalog.json and loaded only when needed.
 */
import type { Product } from './inventory';

export interface CatalogData {
  /** Verified variant + RGBA + weight → EAN. Empty without a licensed crosswalk. */
  rfid?: Record<string, string>;
  articles?: Record<string, string[]>;
  brands: string[];
  /** [brand index, material, color name, #rrggbb or ''] */
  variants: [number, string, string, string][];
  /** barcode → [variant index, net weight in g, 1 if refill] */
  codes: Record<string, [number, number, number]>;
}

export interface CatalogEntry {
  brand: string;
  material: string;
  color: string;
  hex: string;
  weight: number;
  refill: boolean;
}

/** EAN-8, UPC-A, EAN-13 or GTIN-14 with a valid check digit, as 8 or 13 digits; else null. */
export function normalizeGtin(raw: string): string | null {
  let code = raw.trim();
  if (!/^\d+$/.test(code)) return null;
  if (code.length === 12) code = `0${code}`;
  if (code.length === 14 && code.startsWith('0')) code = code.slice(1);
  if (code.length !== 8 && code.length !== 13) return null;
  const digits = [...code].map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check ? code : null;
}

/** Barcode prefixes (GS1 company numbers) Bambu Lab uses. */
const BAMBU_PREFIXES = ['6975337', '6977252'];
export const isBambuBarcode = (code: string): boolean => {
  const gtin = normalizeGtin(code);
  return !!gtin && BAMBU_PREFIXES.some((p) => gtin.startsWith(p));
};

export class Catalog {
  constructor(private data: CatalogData) {}

  private entry(index: number, weight = 0, refill = false): CatalogEntry {
    const [b, material, color, hex] = this.data.variants[index];
    return { brand: this.data.brands[b], material, color, hex, weight, refill };
  }

  /** The filament behind a scanned barcode, or null. */
  lookup(code: string): CatalogEntry | null {
    const gtin = normalizeGtin(code);
    const hit = gtin ? this.data.codes[gtin] : undefined;
    return hit ? this.entry(hit[0], hit[1], hit[2] === 1) : null;
  }

  lookupRfid(variant: string, rgba: string, weight: number): { code: string; entry: CatalogEntry } | null {
    const code = this.data.rfid?.[`${variant}|${rgba.toLowerCase()}|${weight}`];
    const entry = code ? this.lookup(code) : null;
    return code && entry ? { code, entry } : null;
  }

  /** Colors matching every word of the query, Bambu Lab first. */
  search(query: string, limit = 30): CatalogEntry[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const out: { e: CatalogEntry; rank: number }[] = [];
    this.data.variants.forEach((_, i) => {
      const e = this.entry(i);
      const text = `${e.brand} ${e.material} ${e.color} ${germanColorWords(e.color)}`.toLowerCase();
      if (words.every((w) => text.includes(w))) out.push({ e, rank: e.brand === 'Bambu Lab' ? 0 : 1 });
    });
    // Plain colors ("Purple") before compound ones ("Aurora Purple"), then by material.
    const colorWords = (e: CatalogEntry) => e.color.split(/\s+/).length;
    out.sort(
      (a, b) =>
        a.rank - b.rank || colorWords(a.e) - colorWords(b.e) || a.e.material.localeCompare(b.e.material) || a.e.color.localeCompare(b.e.color),
    );
    const seen = new Set<string>();
    return out
      .map((x) => x.e)
      .filter((e) => {
        const key = `${e.brand}|${e.material}|${e.color}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit);
  }
}

/** German words for English color names, so "silk lila" finds "PLA Silk+ Purple". */
const DE: [RegExp, string][] = [
  [/black|charcoal|onyx/i, 'schwarz'],
  [/white|ivory/i, 'weiß weiss'],
  [/gr[ae]y|ash|silver|titan/i, 'grau silber'],
  [/red|scarlet|crimson|maroon/i, 'rot'],
  [/blue|navy|cobalt|azure|cyan|sky/i, 'blau'],
  [/green|lime|mint|olive|jade/i, 'grün gruen'],
  [/yellow|lemon/i, 'gelb'],
  [/orange|pumpkin|mandarin/i, 'orange'],
  [/purple|violet|lilac|lavender|plum/i, 'lila violett'],
  [/pink|magenta|rose|sakura/i, 'pink rosa'],
  [/brown|coffee|chocolate|cocoa|wood|walnut|bronze/i, 'braun'],
  [/beige|sand|desert|latte|cream/i, 'beige'],
  [/gold/i, 'gold'],
  [/turquoise|teal/i, 'türkis tuerkis'],
  [/clear|transparent|natural/i, 'transparent klar natur'],
];
const germanColorWords = (color: string) => DE.filter(([re]) => re.test(color)).map(([, w]) => w).join(' ');

let loading: Promise<Catalog> | null = null;
/** Loads the table once (a separate file, so the app starts without waiting for it). */
export function loadCatalog(): Promise<Catalog> {
  loading ??= import('./catalog.json').then((m) => new Catalog((m.default ?? m) as unknown as CatalogData));
  return loading;
}

/** Product details from a catalog entry. */
export const detailsOf = (e: CatalogEntry): Partial<Product> => ({
  brand: e.brand,
  material: e.material,
  color: e.color,
  hex: e.hex,
  weight: e.weight,
  ...(e.refill ? { note: 'Refill (ohne Spule)' } : {}),
});
