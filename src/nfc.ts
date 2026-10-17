import { addSpool, removeSpoolById, type Inventory, type Product, type Spool } from './inventory';
import { detailsOf, type Catalog } from './catalog';

export interface NfcScan {
  source: 'bambu-rfid'; trayUid: string; tagUid: string; variantId: string; materialId: string;
  type: string; detailedType: string; colorRgba: string; colors: string[];
  weightG: number; diameterMm: number; productionDate: string; lengthM: number;
}

/** The bridge is an input boundary, including in browsers where any script can emit an event. */
export function parseNfcScan(value: unknown): NfcScan | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.source !== 'bambu-rfid') return null;
  for (const key of ['trayUid', 'tagUid', 'variantId', 'materialId', 'type', 'detailedType', 'productionDate']) {
    if (typeof v[key] !== 'string' || v[key].length > 64) return null;
  }
  if (!/^[0-9a-f]{32}$/i.test(v.trayUid as string) || !/^[0-9a-f]{8}$/i.test(v.tagUid as string) ||
      !/^[A-Z0-9-]{1,8}$/.test(v.variantId as string) || !/^GF[A-Z0-9]{3}$/.test(v.materialId as string)) return null;
  if (typeof v.colorRgba !== 'string' || !/^#[0-9a-f]{8}$/i.test(v.colorRgba)) return null;
  if (!Array.isArray(v.colors) || v.colors.length < 1 || v.colors.length > 2 ||
      !v.colors.every(c => typeof c === 'string' && /^#[0-9a-f]{8}$/i.test(c))) return null;
  if (typeof v.weightG !== 'number' || !Number.isFinite(v.weightG) || v.weightG <= 0 || v.weightG > 20000 ||
      typeof v.diameterMm !== 'number' || !Number.isFinite(v.diameterMm) || v.diameterMm < 1 || v.diameterMm > 4 ||
      typeof v.lengthM !== 'number' || !Number.isFinite(v.lengthM) || v.lengthM < 0 || v.lengthM > 65535) return null;
  return { ...v, trayUid: (v.trayUid as string).toUpperCase(), colorRgba: v.colorRgba.toLowerCase(),
    colors: v.colors.map(c => c.toLowerCase()) } as NfcScan;
}

export type NfcResult = { kind: 'duplicate'; code: string } | { kind: 'missing'; code: string } |
  { kind: 'add' | 'remove'; code: string; spool: Spool; isNew: boolean };

export function processNfcScan(inv: Inventory, scan: NfcScan, mode: 'add' | 'remove', catalog?: Catalog | null): NfcResult {
  const existing = inv.spools.find(s => s.tag === scan.trayUid);
  const mapped = catalog?.lookupRfid(scan.variantId, scan.colorRgba, scan.weightG);
  const code = existing?.code ?? mapped?.code ?? `bambu-rfid:${scan.variantId}`;
  if (mode === 'remove') {
    if (!existing) return { kind: 'missing', code };
    return { kind: 'remove', code, spool: removeSpoolById(inv, existing.id)!, isNew: false };
  }
  if (existing) return { kind: 'duplicate', code };
  const details: Partial<Product> = mapped ? detailsOf(mapped.entry) : {
    brand: 'Bambu Lab', material: scan.detailedType || scan.type,
    color: scan.colors.join(' / '), hex: scan.colorRgba.slice(0, 7), weight: scan.weightG,
  };
  const isNew = !inv.products[code];
  const spool = addSpool(inv, code, details);
  // Stable across devices: concurrent offline scans merge into one physical spool.
  spool.id = `nfc:${scan.trayUid}`;
  spool.tag = scan.trayUid;
  spool.updated = Math.max(spool.updated, (inv.deleted[`s:${spool.id}`] ?? 0) + 1);
  return { kind: 'add', code, spool, isNew };
}
