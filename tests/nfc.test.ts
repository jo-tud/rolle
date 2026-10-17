import { describe, expect, it } from 'vitest';
import { encryptJson, decryptJson, randomBytes } from '../src/crypto';
import { emptyInventory, addSpool, parseInventory, restoreSpool, removeSpoolById } from '../src/inventory';
import { canonical, merge } from '../src/merge';
import { parseNfcScan, processNfcScan, type NfcScan } from '../src/nfc';
import { Catalog } from '../src/catalog';

const scan: NfcScan = {
  source: 'bambu-rfid', trayUid: '2F9DAEB30109430EB0DF2BFB3F5D03B5', tagUid: 'FEE749BC',
  variantId: 'A00-K0', materialId: 'GFA00', type: 'PLA', detailedType: 'PLA Basic',
  colorRgba: '#000000ff', colors: ['#000000ff'], weightG: 1000, diameterMm: 1.75,
  productionDate: '2026_05_17_08_44', lengthM: 330,
};

describe('RFID stock workflow', () => {
  it('validates the bridge and normalizes binary tray identities', () => {
    expect(parseNfcScan({ ...scan, trayUid: scan.trayUid.toLowerCase() })?.trayUid).toBe(scan.trayUid);
    for (const bad of [null, {}, {...scan, trayUid: 'x'}, {...scan, weightG: NaN},
      {...scan, colors: ['<script>']}, {...scan, diameterMm: Infinity}, {...scan, source: 'other'}]) {
      expect(parseNfcScan(bad)).toBeNull();
    }
  });
  it('adds details, rejects either side of the same spool, removes exactly that spool and supports undo', () => {
    const inv = emptyInventory();
    const first = processNfcScan(inv, scan, 'add');
    expect(first.kind).toBe('add');
    expect(inv.products['bambu-rfid:A00-K0'].weight).toBe(1000);
    expect(processNfcScan(inv, {...scan, tagUid: '12345678'}, 'add').kind).toBe('duplicate');
    const other = addSpool(inv, 'bambu-rfid:A00-K0');
    const result = processNfcScan(inv, scan, 'remove');
    expect(result.kind).toBe('remove');
    expect(inv.spools).toEqual([other]);
    if (result.kind === 'remove') restoreSpool(inv, result.spool);
    expect(inv.spools.find(s => s.tag === scan.trayUid)).toBeDefined();
    expect(processNfcScan(inv, {...scan, trayUid: 'A'.repeat(32)}, 'remove').kind).toBe('missing');
  });
  it('preserves tags through persistence, encrypted-sync representation, and merge', () => {
    const a = emptyInventory(); const b = emptyInventory();
    processNfcScan(a, scan, 'add'); processNfcScan(b, {...scan, tagUid: '12345678'}, 'add');
    const restored = parseInventory(JSON.parse(JSON.stringify(a)))!;
    expect(restored.spools[0].tag).toBe(scan.trayUid);
    const result = merge(restored, b);
    expect(result.spools).toHaveLength(1);
    expect(canonical(result)).toBe(canonical(merge(b, restored)));
    expect(canonical({...result, spools: result.spools.map(s => ({...s, tag: undefined}))})).not.toBe(canonical(result));
    const removed = result.spools[0];
    removeSpoolById(result, removed.id, removed.updated + 1);
    expect(merge(restored, result).spools).toHaveLength(0);
    expect(parseInventory({products: {}, spools: [{id:'old',code:'old',added:1}]} )?.spools[0].tag).toBeUndefined();
  });
  it('round-trips RFID additions and removals through encrypted sync data', async () => {
    const phone = emptyInventory(); processNfcScan(phone, scan, 'add');
    const key = randomBytes(32);
    const sealed = await encryptJson(key, phone);
    const tablet = parseInventory(await decryptJson(key, sealed.iv, sealed.data))!;
    expect(tablet.spools[0].tag).toBe(scan.trayUid);
    const now = tablet.spools[0].updated + 10;
    removeSpoolById(tablet, tablet.spools[0].id, now);
    const removed = await encryptJson(key, tablet);
    const remote = parseInventory(await decryptJson(key, removed.iv, removed.data))!;
    expect(merge(phone, remote).spools).toHaveLength(0);
  });
  it('groups a verified tag with its carton EAN; mismatched color falls back', () => {
    const code = '6977252427456';
    const catalog = new Catalog({ brands: ['Bambu Lab'], variants: [[0,'PLA Basic','Black','#000000']],
      codes: { [code]: [0, 1000, 0] }, rfid: { 'A00-K0|#000000ff|1000': code } });
    const inv = emptyInventory(); addSpool(inv, code);
    processNfcScan(inv, scan, 'add', catalog);
    expect(inv.spools.map(s => s.code)).toEqual([code, code]);
    expect(catalog.lookupRfid('A00-K0', '#ffffffff', 1000)).toBeNull();
  });
});
