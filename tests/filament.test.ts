import { describe, expect, it } from 'vitest';
import { GONE_MS, RepeatFilter } from '../src/camera';
import { guessDetails } from '../src/guess';
import {
  addSpool,
  countOf,
  emptyInventory,
  groups,
  isDescribed,
  loadInventory,
  parseInventory,
  removeOneSpool,
  saveInventory,
} from '../src/inventory';
import { MAX_GAP_MS, WedgeBuffer } from '../src/wedge';

describe('filament inventory', () => {
  it('learns a code once and counts every spool scanned with it', () => {
    const inv = emptyInventory();
    addSpool(inv, 'A', { material: 'PLA Basic', color: 'Schwarz' });
    addSpool(inv, 'A', { material: 'ignored for a known code' });
    addSpool(inv, 'B');
    expect(countOf(inv, 'A')).toBe(2);
    expect(inv.products.A.material).toBe('PLA Basic');
    expect(isDescribed(inv.products.B)).toBe(false);
  });

  it('takes out an opened spool first, otherwise the oldest', () => {
    const inv = emptyInventory();
    const first = addSpool(inv, 'A', {}, 1);
    const second = addSpool(inv, 'A', {}, 2);
    const third = addSpool(inv, 'A', {}, 3);
    second.opened = true;
    expect(removeOneSpool(inv, 'A')?.id).toBe(second.id);
    expect(removeOneSpool(inv, 'A')?.id).toBe(first.id);
    expect(removeOneSpool(inv, 'A')?.id).toBe(third.id);
    expect(removeOneSpool(inv, 'A')).toBeNull();
    // The code stays known, so the next spool of this kind is recognized.
    expect(inv.products.A).toBeDefined();
  });

  it('lists kinds without details first, then by material and color', () => {
    const inv = emptyInventory();
    addSpool(inv, 'petg', { material: 'PETG HF', color: 'Blau' });
    addSpool(inv, 'pla-w', { material: 'PLA Basic', color: 'Weiß' });
    addSpool(inv, 'pla-b', { material: 'PLA Basic', color: 'Schwarz' });
    addSpool(inv, 'unknown');
    expect(groups(inv).map((g) => g.product.code)).toEqual(['unknown', 'petg', 'pla-b', 'pla-w']);
  });

  it('survives a save and load, and drops malformed entries on import', () => {
    const inv = emptyInventory();
    addSpool(inv, 'A', { material: 'PLA', hex: '#ff0000', weight: 1000 });
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(saveInventory(storage, inv)).toBe(true);
    expect(loadInventory(storage)).toEqual(inv);

    const messy = parseInventory({
      products: { A: { material: 'PLA', hex: 'red', weight: -1 } },
      spools: [{ code: 'A' }, { code: '' }, 'x', { code: 'Z', id: 'same' }, { code: 'Z', id: 'same' }],
    })!;
    expect(messy.products.A.hex).toBe('');
    expect(messy.products.A.weight).toBe(0);
    expect(messy.spools.map((s) => s.code)).toEqual(['A', 'Z', 'Z']);
    expect(new Set(messy.spools.map((s) => s.id)).size).toBe(3);
    expect(messy.products.Z).toBeDefined();
    expect(parseInventory({ nope: true })).toBeNull();
    expect(loadInventory({ getItem: () => '{broken' }).spools).toEqual([]);
  });
});

describe('guessing details from a code', () => {
  it('reads a shop link', () => {
    const g = guessDetails('https://eu.store.bambulab.com/de/products/pla-matte?variant=Charcoal%20Black');
    expect(g.brand).toBe('Bambu Lab');
    expect(g.material).toBe('PLA Matte');
    expect(g.color).toBe('Schwarz');
  });

  it('prefers the most specific material', () => {
    expect(guessDetails('PETG HF Blue 1kg').material).toBe('PETG HF');
    expect(guessDetails('PLA Silk+ Gold').material).toBe('PLA Silk+');
    expect(guessDetails('Bambu PLA-CF').material).toBe('PLA-CF');
    expect(guessDetails('PETG Blue').material).toBe('PETG');
  });

  it('reads JSON codes', () => {
    const g = guessDetails('{"type":"petg hf","color_hex":"#FF8800FF","vendor":"Polymaker","weight":"1"}');
    expect(g).toMatchObject({ material: 'PETG HF', hex: '#ff8800', brand: 'Polymaker', weight: 1000 });
  });

  it('reads weight and color words', () => {
    const g = guessDetails('Sunlu PLA weiß 500 g');
    expect(g).toMatchObject({ brand: 'Sunlu', material: 'PLA', color: 'Weiß', weight: 500 });
  });

  it('leaves an opaque serial alone', () => {
    expect(guessDetails('A00-K0-1.75-1000-SPL')).toEqual({});
    expect(guessDetails('10101')).toEqual({});
  });
});

describe('hand scanner detection', () => {
  const type = (b: WedgeBuffer, text: string, start: number, gap: number) => {
    let t = start;
    let last = { code: null as string | null, consume: false };
    for (const key of [...text, 'Enter']) {
      last = b.feed(key, t);
      t += gap;
    }
    return last;
  };

  it('takes a fast burst ending in Enter as a scan', () => {
    const r = type(new WedgeBuffer(), 'https://x.y/PLA', 0, 8);
    expect(r).toEqual({ code: 'https://x.y/PLA', consume: true });
  });

  it('ignores slow typing and lone Enter presses', () => {
    expect(type(new WedgeBuffer(), 'abcd', 0, MAX_GAP_MS + 50).code).toBeNull();
    expect(new WedgeBuffer().feed('Enter', 5)).toEqual({ code: null, consume: false });
  });

  it('keeps Shift between characters and starts over after a pause', () => {
    const b = new WedgeBuffer();
    b.feed('a', 0);
    b.feed('Shift', 5);
    b.feed('B', 10);
    b.feed('c', 15);
    expect(b.feed('Enter', 20).code).toBe('aBc');
    b.feed('x', 100);
    b.feed('y', 105);
    // A pause, then a new burst: only the new one counts.
    for (const [i, k] of [...'code'].entries()) b.feed(k, 1000 + i * 5);
    expect(b.feed('Enter', 1030).code).toBe('code');
  });
});

describe('camera repeat filter', () => {
  it('counts a code once while it stays in view, again after it was gone', () => {
    const f = new RepeatFilter();
    expect(f.accept(['A'], 0)).toEqual(['A']);
    expect(f.accept(['A'], 100)).toEqual([]);
    expect(f.accept(['A'], 100 + GONE_MS)).toEqual([]);
    expect(f.accept(['A', 'B'], 100 + GONE_MS * 2 + 1)).toEqual(['A', 'B']);
  });
});
