// Builds src/catalog.json from a checkout of the Open Filament Database (MIT licensed):
//   git clone --depth 1 https://github.com/OpenFilamentCollective/open-filament-database /tmp/ofd
//   node scripts/build-catalog.mjs /tmp/ofd
// The table maps barcodes (EAN/GTIN) to brand, material, color and color value, and lists all
// Bambu Lab colors for the search in the edit dialog.
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (!root || !existsSync(join(root, 'data'))) {
  console.error('usage: node scripts/build-catalog.mjs <path to open-filament-database checkout>');
  process.exit(1);
}
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const dirs = (p) => readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

/** EAN-8, UPC-A (12), EAN-13 and GTIN-14 with a valid check digit, as the 8 or 13 digit form. */
export function normalizeGtin(raw) {
  let code = String(raw ?? '').replace(/\D/g, '');
  if (code.length === 12) code = `0${code}`;
  if (code.length === 14 && code.startsWith('0')) code = code.slice(1);
  if (code.length !== 8 && code.length !== 13) return null;
  const digits = [...code].map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check ? code : null;
}

const brands = [];
const variants = [];
const codes = {};
let conflicts = 0;
let invalid = 0;

for (const brandDir of dirs(join(root, 'data')).sort()) {
  const base = join(root, 'data', brandDir);
  if (!existsSync(join(base, 'brand.json'))) continue;
  const brand = read(join(base, 'brand.json')).name;
  const isBambu = brandDir === 'bambu_lab';
  let brandIndex = -1;
  for (const materialDir of dirs(base).sort()) {
    const matFile = join(base, materialDir, 'material.json');
    const materialType = existsSync(matFile) ? read(matFile).material : materialDir;
    for (const filamentDir of dirs(join(base, materialDir)).sort()) {
      const filFile = join(base, materialDir, filamentDir, 'filament.json');
      if (!existsSync(filFile)) continue;
      const name = read(filFile).name.trim();
      const material = name.toLowerCase().includes(String(materialType).toLowerCase()) ? name : `${materialType} ${name}`;
      for (const variantDir of dirs(join(base, materialDir, filamentDir)).sort()) {
        const dir = join(base, materialDir, filamentDir, variantDir);
        if (!existsSync(join(dir, 'variant.json'))) continue;
        const v = read(join(dir, 'variant.json'));
        const hexRaw = Array.isArray(v.color_hex) ? v.color_hex[0] : v.color_hex;
        const hex = /^#?[0-9a-f]{6}/i.test(hexRaw ?? '') ? `#${hexRaw.replace('#', '').slice(0, 6).toLowerCase()}` : '';
        const sizes = existsSync(join(dir, 'sizes.json')) ? read(join(dir, 'sizes.json')) : [];
        const withCode = sizes.filter((s) => s.ean || s.gtin);
        if (!isBambu && withCode.length === 0) continue;
        if (brandIndex < 0) brandIndex = brands.push(brand) - 1;
        const index = variants.push([brandIndex, material, v.name.trim(), hex]) - 1;
        for (const s of withCode) {
          const code = normalizeGtin(s.ean || s.gtin);
          if (!code) {
            invalid++;
            continue;
          }
          const entry = [index, Math.round(s.filament_weight || 0), s.spool_refill ? 1 : 0];
          if (codes[code] && codes[code][0] !== index) {
            conflicts++;
            continue;
          }
          codes[code] = entry;
        }
      }
    }
  }
}

let commit = '';
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
} catch {
  // Not a git checkout.
}
const out = {
  source: 'Open Filament Database, https://github.com/OpenFilamentCollective/open-filament-database (MIT)',
  commit,
  brands,
  variants,
  codes,
};
writeFileSync(new URL('../src/catalog.json', import.meta.url), JSON.stringify(out));
console.log(`${brands.length} brands, ${variants.length} colors, ${Object.keys(codes).length} barcodes (${invalid} invalid, ${conflicts} conflicting skipped)`);
