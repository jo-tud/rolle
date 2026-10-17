import { describe, expect, it } from 'vitest';
import { Catalog, detailsOf, isBambuBarcode, normalizeGtin, type CatalogData } from '../src/catalog';
import data from '../src/catalog.json';
import { guessDetails } from '../src/guess';

const catalog = new Catalog(data as unknown as CatalogData);

describe('barcodes', () => {
  it('accepts EAN-13, UPC-A and GTIN-14 with a valid check digit only', () => {
    expect(normalizeGtin('6977252427456')).toBe('6977252427456');
    expect(normalizeGtin('6977252427457')).toBeNull();
    expect(normalizeGtin('06977252427456')).toBe('6977252427456');
    expect(normalizeGtin('036000291452')).toBe('0036000291452');
    expect(normalizeGtin('PLA Basic')).toBeNull();
    expect(normalizeGtin('10101')).toBeNull();
  });

  it('knows Bambu Lab by its barcode prefix', () => {
    expect(isBambuBarcode('6977252427456')).toBe(true);
    expect(isBambuBarcode('6975337030164')).toBe(true);
    expect(isBambuBarcode('4006381333931')).toBe(false);
    expect(guessDetails('6977252427456').brand).toBe('Bambu Lab');
  });
});

describe('catalog', () => {
  it('names the filament behind a box barcode', () => {
    const hit = catalog.lookup('6977252427456');
    expect(hit).toMatchObject({ brand: 'Bambu Lab', material: 'PLA Silk+', color: 'Purple', weight: 1000, refill: false });
    expect(hit!.hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(detailsOf(hit!)).toMatchObject({ brand: 'Bambu Lab', material: 'PLA Silk+' });
    expect(catalog.lookup('4006381333931')).toBeNull();
  });

  it('finds colors by German words, Bambu Lab first', () => {
    const hits = catalog.search('silk lila');
    expect(hits[0]).toMatchObject({ brand: 'Bambu Lab', material: 'PLA Silk+', color: 'Purple' });
    expect(catalog.search('matte schwarz').some((e) => e.brand === 'Bambu Lab' && e.material === 'PLA Matte')).toBe(true);
    expect(catalog.search('')).toEqual([]);
  });
});
