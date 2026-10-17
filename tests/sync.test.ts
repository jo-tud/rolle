import { describe, expect, it } from 'vitest';
import { decryptJson, deriveKey, encryptJson, randomBytes, toBase64 } from '../src/crypto';
import {
  addSpool,
  deleteProduct,
  emptyInventory,
  removeOneSpool,
  removeSpoolById,
  restoreSpool,
  setOpened,
  setProduct,
  type Inventory,
} from '../src/inventory';
import { KEEP_DELETED_MS, canonical, merge, sameContent } from '../src/merge';
import {
  FILE_NAME,
  GistApi,
  SyncEngine,
  SyncError,
  createVault,
  pairingLink,
  parsePairing,
  probe,
  unlock,
  type SyncConfig,
  type SyncState,
} from '../src/sync';

const copy = (inv: Inventory): Inventory => structuredClone(inv);

describe('merging two devices', () => {
  it('keeps what both added', () => {
    const base = emptyInventory();
    addSpool(base, 'A', { material: 'PLA' }, 1);
    const phone = copy(base);
    const pc = copy(base);
    addSpool(phone, 'A', {}, 10);
    addSpool(pc, 'B', { material: 'PETG' }, 11);
    const m = merge(phone, pc, 100);
    expect(m.spools.map((s) => s.code).sort()).toEqual(['A', 'A', 'B']);
    expect(m.products.B.material).toBe('PETG');
  });

  it('lets a removal win over older changes, and a later undo win over the removal', () => {
    const base = emptyInventory();
    const s = addSpool(base, 'A', {}, 1);
    const phone = copy(base);
    const pc = copy(base);
    setOpened(pc.spools[0], true, 5);
    removeSpoolById(phone, s.id, 10);
    expect(merge(phone, pc, 100).spools).toEqual([]);
    expect(merge(pc, phone, 100).spools).toEqual([]);

    restoreSpool(phone, s, 20);
    expect(merge(pc, phone, 100).spools.map((x) => x.id)).toEqual([s.id]);
  });

  it('takes the newer product details and forgets a deleted kind', () => {
    const base = emptyInventory();
    addSpool(base, 'A', { material: 'PLA' }, 1);
    const phone = copy(base);
    const pc = copy(base);
    setProduct(phone, { ...phone.products.A, color: 'Rot' }, 5);
    setProduct(pc, { ...pc.products.A, color: 'Blau' }, 6);
    expect(merge(phone, pc, 100).products.A.color).toBe('Blau');

    deleteProduct(phone, 'A', 7);
    const m = merge(phone, pc, 100);
    expect(m.spools).toEqual([]);
    expect(m.products.A).toBeUndefined();
  });

  it('is order-independent and settles after one merge', () => {
    const a = emptyInventory();
    addSpool(a, 'A', { material: 'PLA' }, 1);
    const b = copy(a);
    addSpool(b, 'B', {}, 2);
    removeOneSpool(a, 'A', 3);
    // Same time stamp, different content: every device must pick the same one.
    setProduct(b, { ...b.products.A, note: 'b' }, 4);
    setProduct(a, { ...a.products.A, note: 'a' }, 4);
    const ab = merge(a, b, 100);
    const ba = merge(b, a, 100);
    expect(canonical(ab)).toBe(canonical(ba));
    expect(sameContent(merge(ab, b, 100), ab)).toBe(true);
    expect(sameContent(merge(ab, ab, 100), ab)).toBe(true);
  });

  it('drops removal notes after a year', () => {
    const a = emptyInventory();
    a.deleted['s:old'] = 0;
    a.deleted['s:new'] = KEEP_DELETED_MS;
    expect(Object.keys(merge(a, emptyInventory(), KEEP_DELETED_MS + 1).deleted)).toEqual(['s:new']);
  });
});

describe('encryption', () => {
  it('seals and opens with the same password only', async () => {
    const salt = randomBytes(16);
    const key = await deriveKey('Rolle rollt', salt, 1000);
    const sealed = await encryptJson(key, { secret: 'PLA Matte Schwarz' });
    expect(atob(sealed.data)).not.toContain('PLA');
    expect(await decryptJson(await deriveKey('Rolle rollt', salt, 1000), sealed.iv, sealed.data)).toEqual({ secret: 'PLA Matte Schwarz' });
    await expect(decryptJson(await deriveKey('rolle rollt', salt, 1000), sealed.iv, sealed.data)).rejects.toThrow();
  });
});

describe('pairing link', () => {
  it('carries token and Gist but no password', () => {
    const link = pairingLink('https://jo-tud.github.io/rolle/#old', { token: 'ghp_x', gistId: 'abc' });
    expect(link.startsWith('https://jo-tud.github.io/rolle/#verbinden=')).toBe(true);
    expect(parsePairing(link)).toEqual({ token: 'ghp_x', gistId: 'abc' });
    expect(parsePairing(link.split('#')[1])).toEqual({ token: 'ghp_x', gistId: 'abc' });
    expect(parsePairing('https://example.com/verbinden=abc')).toBeNull();
    expect(parsePairing('PLA Basic')).toBeNull();
  });
});

/** A small stand-in for the GitHub Gist API. */
class FakeGitHub {
  gists = new Map<string, { owner: string; content: string; version: number }>();
  tokens = new Map<string, string>([
    ['ghp_jo', 'jo'],
    ['ghp_other', 'someone'],
  ]);
  online = true;
  writes = 0;
  private next = 1;

  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (!this.online) throw new TypeError('Failed to fetch');
    const headers = (init.headers ?? {}) as Record<string, string>;
    const login = this.tokens.get(headers.Authorization?.replace('Bearer ', '') ?? '');
    if (!login) return new Response('{}', { status: 401 });
    const path = url.replace('https://api.github.com', '');
    const method = init.method ?? 'GET';
    const json = (v: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json', ...extra } });
    const view = (id: string) => {
      const g = this.gists.get(id)!;
      return { id, files: { [FILE_NAME]: { content: g.content, truncated: false } } };
    };
    if (path === '/user') return json({ login }, { 'x-oauth-scopes': 'gist' });
    if (path.startsWith('/gists?')) {
      return json([...this.gists.keys()].filter((id) => this.gists.get(id)!.owner === login).map(view));
    }
    if (path === '/gists' && method === 'POST') {
      const body = JSON.parse(String(init.body));
      const id = `g${this.next++}`;
      this.gists.set(id, { owner: login, content: body.files[FILE_NAME].content, version: 1 });
      return json({ id });
    }
    const id = decodeURIComponent(path.slice('/gists/'.length));
    const g = this.gists.get(id);
    if (!g || g.owner !== login) return new Response('{}', { status: 404 });
    if (method === 'PATCH') {
      this.writes++;
      g.content = JSON.parse(String(init.body)).files[FILE_NAME].content;
      g.version++;
      return json(view(id));
    }
    const etag = `"v${g.version}"`;
    if (headers['If-None-Match'] === etag) return new Response(null, { status: 304 });
    return json(view(id), { etag });
  };
}

function device(github: FakeGitHub, cfg: SyncConfig, start: Inventory) {
  let inv = start;
  const states: SyncState[] = [];
  const engine = new SyncEngine(
    cfg,
    new GistApi(cfg.token, github.fetch),
    { get: () => inv, apply: (m) => (inv = merge(inv, m)) },
    (s) => states.push(s),
  );
  return {
    engine,
    states,
    get inv() {
      return inv;
    },
  };
}

describe('syncing through a Gist', () => {
  it('sets up, pairs a second device and keeps both in step', async () => {
    const github = new FakeGitHub();
    const phoneStock = emptyInventory();
    addSpool(phoneStock, 'pla', { material: 'PLA Basic', color: 'Schwarz' });

    // Phone: first setup creates the Gist with its stock.
    const apiA = new GistApi('ghp_jo', github.fetch);
    expect(await probe(apiA)).toEqual({ login: 'jo', gistId: null, envelope: null });
    const vault = await createVault(apiA, 'geheim123', phoneStock);
    const stored = github.gists.get(vault.gistId)!.content;
    expect(stored).not.toContain('PLA');

    // PC: finds the Gist by itself; the wrong password is refused.
    const found = await probe(new GistApi('ghp_jo', github.fetch));
    expect(found.gistId).toBe(vault.gistId);
    await expect(unlock(found.envelope!, 'falsch')).rejects.toMatchObject({ kind: 'password' });
    const { key, remote } = await unlock(found.envelope!, 'geheim123');
    expect(remote.spools).toHaveLength(1);

    const cfg = (k: Uint8Array): SyncConfig => ({
      token: 'ghp_jo',
      gistId: vault.gistId,
      login: 'jo',
      key: toBase64(k),
      salt: vault.salt,
      iterations: vault.iterations,
    });
    const pcStock = emptyInventory();
    addSpool(pcStock, 'petg', { material: 'PETG HF' });
    const phone = device(github, cfg(vault.key), phoneStock);
    const pc = device(github, cfg(key), pcStock);

    await pc.engine.sync();
    expect(pc.inv.spools.map((s) => s.code).sort()).toEqual(['petg', 'pla']);

    // Both change something before syncing again.
    removeOneSpool(phone.inv, 'pla');
    addSpool(pc.inv, 'pla');
    await phone.engine.sync();
    await pc.engine.sync();
    await phone.engine.sync();
    expect(canonical(phone.inv)).toBe(canonical(pc.inv));
    expect(phone.inv.spools.map((s) => s.code).sort()).toEqual(['petg', 'pla']);

    // Nothing new: no further writes (the unchanged Gist answers 304).
    const writes = github.writes;
    await phone.engine.sync();
    await pc.engine.sync();
    expect(github.writes).toBe(writes);
    expect(phone.states.at(-1)).toMatchObject({ phase: 'ok' });
  });

  it('reports a missing connection and a rejected token', async () => {
    const github = new FakeGitHub();
    const vault = await createVault(new GistApi('ghp_jo', github.fetch), 'geheim123', emptyInventory());
    const cfg: SyncConfig = { token: 'ghp_jo', gistId: vault.gistId, login: 'jo', key: toBase64(vault.key), salt: vault.salt, iterations: vault.iterations };
    const d = device(github, cfg, emptyInventory());
    github.online = false;
    await d.engine.sync();
    expect(d.states.at(-1)).toMatchObject({ phase: 'error', error: { kind: 'offline' } });
    github.online = true;
    github.tokens.delete('ghp_jo');
    await d.engine.sync();
    const last = d.states.at(-1);
    expect(last?.phase === 'error' && last.error).toBeInstanceOf(SyncError);
    expect(last).toMatchObject({ phase: 'error', error: { kind: 'token' } });
  });

  it("does not show one user's Gist to another", async () => {
    const github = new FakeGitHub();
    await createVault(new GistApi('ghp_jo', github.fetch), 'geheim123', emptyInventory());
    expect((await probe(new GistApi('ghp_other', github.fetch))).gistId).toBeNull();
  });
});
