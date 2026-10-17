/**
 * Best guess at what a scanned code describes. Codes on spools come in many shapes (a link to the
 * shop, a bit of JSON, a plain product name or just a number), so this only pre-fills the form for a
 * code seen for the first time; whatever is saved there is what the code means from then on.
 */
import { isBambuBarcode } from './catalog';
import type { Product } from './inventory';

/** Material names, most specific first, so "PLA Silk+" wins over "PLA". */
export const MATERIALS = [
  'PLA Basic Gradient',
  'PLA Basic',
  'PLA Matte',
  'PLA Silk+',
  'PLA Silk Multi-Color',
  'PLA Silk',
  'PLA Tough+',
  'PLA Tough',
  'PLA Galaxy',
  'PLA Sparkle',
  'PLA Metal',
  'PLA Marble',
  'PLA Glow',
  'PLA Wood',
  'PLA Translucent',
  'PLA Lite',
  'PLA Aero',
  'PLA-CF',
  'PETG HF',
  'PETG Translucent',
  'PETG Basic',
  'PETG-CF',
  'PET-CF',
  'ABS-GF',
  'ASA Aero',
  'ASA-CF',
  'PAHT-CF',
  'PA6-CF',
  'PA6-GF',
  'PPA-CF',
  'PPS-CF',
  'TPU 95A HF',
  'TPU for AMS',
  'TPU 90A',
  'TPU 85A',
  'Support for PLA/PETG',
  'Support for PLA',
  'Support for ABS',
  'Support for PA/PET',
  'PVA',
  'HIPS',
  'PETG',
  'PLA',
  'ABS',
  'ASA',
  'TPU',
  'PC',
  'PA',
  'PET',
];

export const BRANDS = [
  'Bambu Lab',
  'Polymaker',
  'Prusament',
  'eSun',
  'Sunlu',
  'Elegoo',
  'Eryone',
  'Jayo',
  'Overture',
  'Extrudr',
  'Das Filament',
  'Geeetech',
  '3DJake',
  'Kingroon',
  'Anycubic',
  'Creality',
];

/** A whole word (JavaScript's \\b does not know umlauts or ß). */
const word = (alternatives: string) => new RegExp(`(?<![a-zäöüß])(${alternatives})(?![a-zäöüß])`);

/** Color words in German and English, with a typical shade. */
const COLORS: [RegExp, string, string][] = [
  [word('black|schwarz'), 'Schwarz', '#161616'],
  [word('white|wei(ss|ß)'), 'Weiß', '#f4f4f2'],
  [word('ivory|elfenbein'), 'Elfenbein', '#ede6d3'],
  [word('red|rot'), 'Rot', '#c8102e'],
  [word('blue|blau'), 'Blau', '#0a4ea2'],
  [word('green|gr(ue|ü)n'), 'Grün', '#00a14b'],
  [word('yellow|gelb'), 'Gelb', '#f4d000'],
  [word('orange'), 'Orange', '#ff6a13'],
  [word('gr[ae]y|grau'), 'Grau', '#8e9089'],
  [word('silver|silber'), 'Silber', '#a6a9aa'],
  [word('gold'), 'Gold', '#c9a227'],
  [word('purple|violet|lila|violett'), 'Lila', '#5e43b7'],
  [word('pink|rosa'), 'Pink', '#f55a9e'],
  [word('brown|braun'), 'Braun', '#7d6556'],
  [word('beige'), 'Beige', '#d3b7a7'],
  [word('cyan|t(ue|ü)rkis|turquoise'), 'Türkis', '#00a6a0'],
  [word('magenta'), 'Magenta', '#c2185b'],
  [word('clear|transparent|natural|natur'), 'Transparent', ''],
];

const JSON_KEYS: Record<string, keyof Product> = {
  material: 'material',
  type: 'material',
  filament: 'material',
  filament_type: 'material',
  tray_type: 'material',
  color: 'color',
  colour: 'color',
  color_name: 'color',
  hex: 'hex',
  color_hex: 'hex',
  tray_color: 'hex',
  brand: 'brand',
  vendor: 'brand',
  manufacturer: 'brand',
  weight: 'weight',
  net_weight: 'weight',
};

const words = (name: string) =>
  name
    .split(/[\s\-/+]+/)
    .filter(Boolean)
    .map((w) => w.replace(/[.*?^${}()|[\]\\]/g, '\\$&'));

const materialPatterns = MATERIALS.map((name) => {
  const plus = name.endsWith('+') ? '\\s*\\+' : '';
  return { name, re: new RegExp(`(^|[^a-z0-9])${words(name).join('[\\s_\\-/]*')}${plus}(?![a-z0-9])`, 'i') };
});

/** Turns a code into searchable words (URL paths and query strings become plain text). */
function textOf(code: string): string {
  let text = code;
  if (/^https?:\/\//i.test(code)) {
    try {
      const url = new URL(code);
      text = `${url.hostname} ${url.pathname} ${[...url.searchParams.values()].join(' ')}`;
    } catch {
      // Not a valid URL after all: use it as it is.
    }
  }
  try {
    text = decodeURIComponent(text);
  } catch {
    // Stray % signs: keep the raw text.
  }
  return text.replace(/[_]+/g, ' ');
}

function normalizeHex(v: string): string {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v.trim());
  return m ? `#${m[1].toLowerCase()}` : '';
}

function fromJson(code: string): Partial<Product> | null {
  if (!code.startsWith('{')) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(code);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const out: Partial<Product> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const field = JSON_KEYS[k.toLowerCase()];
    if (!field || out[field] !== undefined) continue;
    if (field === 'weight') {
      const n = typeof v === 'number' ? v : parseFloat(String(v));
      if (n > 0) out.weight = n < 10 ? Math.round(n * 1000) : Math.round(n);
    } else if (field === 'hex') {
      const hex = normalizeHex(String(v));
      if (hex) out.hex = hex;
    } else if (typeof v === 'string' && v.trim()) {
      out[field] = v.trim() as never;
    }
  }
  return out;
}

export function guessDetails(code: string): Partial<Product> {
  const out: Partial<Product> = fromJson(code) ?? {};
  const text = textOf(code);
  const lower = text.toLowerCase();

  if (out.material) {
    const known = materialPatterns.find((m) => m.re.test(out.material!));
    if (known) out.material = known.name;
  } else {
    const m = materialPatterns.find((p) => p.re.test(text));
    if (m) out.material = m.name;
  }

  if (!out.brand) {
    if (/bambu/i.test(text) || isBambuBarcode(code)) out.brand = 'Bambu Lab';
    else {
      const b = BRANDS.find((name) => lower.includes(name.toLowerCase()));
      if (b) out.brand = b;
    }
  }

  if (!out.hex) {
    const m = /#([0-9a-f]{6})(?:[0-9a-f]{2})?(?![0-9a-z])/i.exec(text);
    if (m) out.hex = `#${m[1].toLowerCase()}`;
  }

  if (!out.color) {
    for (const [re, name, hex] of COLORS) {
      if (re.test(lower)) {
        out.color = name;
        if (!out.hex && hex) out.hex = hex;
        break;
      }
    }
  }

  if (!out.weight) {
    const m = /(?:^|[^0-9.,])(\d+(?:[.,]\d+)?)\s*(kg|g)(?![a-z])/i.exec(text);
    if (m) {
      const n = parseFloat(m[1].replace(',', '.'));
      const g = m[2].toLowerCase() === 'kg' ? n * 1000 : n;
      if (g >= 100 && g <= 10000) out.weight = Math.round(g);
    }
  }
  return out;
}
