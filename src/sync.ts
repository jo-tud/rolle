/**
 * Keeps the stock in step across devices through a secret Gist in the user's own GitHub account.
 * The Gist holds one encrypted file; GitHub (and anyone who finds the Gist) sees only ciphertext.
 * Each device keeps the GitHub token and the derived key, never the password itself.
 */
import { ITERATIONS, decryptJson, deriveKey, encryptJson, fromBase64, randomBytes, toBase64, toBase64Url } from './crypto';
import { parseInventory, type Inventory } from './inventory';
import { merge, sameContent } from './merge';

export const FILE_NAME = 'rolle-bestand.json';
export const GIST_DESCRIPTION = 'Rolle – verschlüsselter Filament-Bestand (nur mit deinem Kennwort lesbar)';
const API = 'https://api.github.com';

/** A classic token with nothing but the gist scope (fine-grained tokens cannot reach Gists). */
export const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=gist&description=Rolle%20Sync';

export interface Envelope {
  app: 'rolle';
  format: 1;
  kdf: { name: 'PBKDF2-SHA256'; iterations: number; salt: string };
  iv: string;
  data: string;
}

export interface SyncConfig {
  token: string;
  gistId: string;
  login: string;
  /** Derived key, base64. */
  key: string;
  /** Key derivation parameters, to set the Gist up again if it was deleted. */
  salt: string;
  iterations: number;
}

export type SyncErrorKind = 'token' | 'scope' | 'missing' | 'offline' | 'password' | 'format' | 'rate' | 'other';

export class SyncError extends Error {
  constructor(
    readonly kind: SyncErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export const MESSAGES: Record<SyncErrorKind, string> = {
  token: 'GitHub lehnt den Zugangsschlüssel ab (abgelaufen oder gelöscht?).',
  scope: 'Dem Zugangsschlüssel fehlt das Häkchen „gist“.',
  missing: 'Die Ablage in GitHub wurde nicht gefunden (gelöscht?).',
  offline: 'Keine Verbindung – wird nachgeholt.',
  password: 'Das Kennwort passt nicht.',
  format: 'Die Ablage in GitHub ist beschädigt oder stammt nicht von Rolle.',
  rate: 'GitHub bremst gerade (zu viele Anfragen). Später geht es weiter.',
  other: 'GitHub hat unerwartet geantwortet.',
};

const fail = (kind: SyncErrorKind) => new SyncError(kind, MESSAGES[kind]);

function parseEnvelope(text: string): Envelope {
  let v: Partial<Envelope>;
  try {
    v = JSON.parse(text);
  } catch {
    throw fail('format');
  }
  if (
    v?.app !== 'rolle' ||
    v.format !== 1 ||
    typeof v.iv !== 'string' ||
    typeof v.data !== 'string' ||
    typeof v.kdf?.salt !== 'string' ||
    !(Number(v.kdf?.iterations) > 0)
  ) {
    throw fail('format');
  }
  return v as Envelope;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The few GitHub calls the sync needs. */
export class GistApi {
  private fetchFn: Fetch;

  constructor(
    private token: string,
    fetchFn?: Fetch,
  ) {
    this.fetchFn = fetchFn ?? ((input, init) => globalThis.fetch(input, init));
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(path.startsWith('http') ? path : API + path, {
        ...init,
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch {
      throw fail('offline');
    }
    if (res.ok || res.status === 304) return res;
    if (res.status === 401) throw fail('token');
    if (res.status === 403 || res.status === 429) {
      throw fail(res.headers.get('x-ratelimit-remaining') === '0' || res.status === 429 ? 'rate' : 'scope');
    }
    if (res.status === 404) throw fail('missing');
    throw fail('other');
  }

  /** Checks the token and returns the GitHub user name. */
  async login(): Promise<string> {
    const res = await this.call('/user');
    const scopes = res.headers.get('x-oauth-scopes');
    // Classic tokens list their scopes; without gist the Gist calls would fail later.
    if (scopes !== null && !scopes.split(',').map((s) => s.trim()).includes('gist')) throw fail('scope');
    return String(((await res.json()) as { login?: string }).login ?? '');
  }

  /** The id of the user's Rolle Gist, or null when there is none yet. */
  async find(): Promise<string | null> {
    for (let page = 1; page <= 10; page++) {
      const list = (await (await this.call(`/gists?per_page=100&page=${page}`)).json()) as {
        id: string;
        files: Record<string, unknown>;
      }[];
      const hit = list.find((g) => g.files && FILE_NAME in g.files);
      if (hit) return hit.id;
      if (list.length < 100) return null;
    }
    return null;
  }

  /** Reads the file. Returns 'unchanged' when it is the same as at `etag`. */
  async read(gistId: string, etag?: string): Promise<{ envelope: Envelope; etag: string | null } | 'unchanged'> {
    const res = await this.call(`/gists/${encodeURIComponent(gistId)}`, {
      headers: etag ? { 'If-None-Match': etag } : {},
    });
    if (res.status === 304) return 'unchanged';
    const gist = (await res.json()) as { files?: Record<string, { content?: string; truncated?: boolean; raw_url?: string }> };
    const file = gist.files?.[FILE_NAME];
    if (!file) throw fail('missing');
    let content = file.content ?? '';
    if (file.truncated && file.raw_url) content = await (await this.call(file.raw_url)).text();
    return { envelope: parseEnvelope(content), etag: res.headers.get('etag') };
  }

  async create(envelope: Envelope): Promise<string> {
    const res = await this.call('/gists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: GIST_DESCRIPTION, public: false, files: { [FILE_NAME]: { content: JSON.stringify(envelope) } } }),
    });
    return String(((await res.json()) as { id?: string }).id ?? '');
  }

  async write(gistId: string, envelope: Envelope): Promise<void> {
    await this.call(`/gists/${encodeURIComponent(gistId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: { [FILE_NAME]: { content: JSON.stringify(envelope) } } }),
    });
  }
}

// ---- sealing -----------------------------------------------------------------------------------

export async function seal(key: Uint8Array<ArrayBuffer>, salt: string, iterations: number, inv: Inventory): Promise<Envelope> {
  const { iv, data } = await encryptJson(key, inv);
  return { app: 'rolle', format: 1, kdf: { name: 'PBKDF2-SHA256', iterations, salt }, iv, data };
}

export async function open(key: Uint8Array<ArrayBuffer>, envelope: Envelope): Promise<Inventory> {
  let raw: unknown;
  try {
    raw = await decryptJson(key, envelope.iv, envelope.data);
  } catch {
    throw fail('password');
  }
  const inv = parseInventory(raw);
  if (!inv) throw fail('format');
  return inv;
}

// ---- connecting a device -----------------------------------------------------------------------

export interface Probe {
  login: string;
  gistId: string | null;
  envelope: Envelope | null;
}

/** First step: checks the token and looks for an existing Rolle Gist. */
export async function probe(api: GistApi, gistId?: string): Promise<Probe> {
  const login = await api.login();
  const id = gistId || (await api.find());
  if (!id) return { login, gistId: null, envelope: null };
  const r = await api.read(id);
  if (r === 'unchanged') throw fail('other');
  return { login, gistId: id, envelope: r.envelope };
}

/** Opens an existing Gist with the password. Throws a 'password' error when it does not fit. */
export async function unlock(envelope: Envelope, password: string): Promise<{ key: Uint8Array<ArrayBuffer>; remote: Inventory }> {
  const key = await deriveKey(password, fromBase64(envelope.kdf.salt), envelope.kdf.iterations);
  return { key, remote: await open(key, envelope) };
}

/** Puts the current stock into a new Gist with the device's existing key (the old Gist is gone). */
export async function recreateVault(api: GistApi, cfg: SyncConfig, inv: Inventory): Promise<string> {
  const gistId = await api.create(await seal(fromBase64(cfg.key), cfg.salt, cfg.iterations, inv));
  if (!gistId) throw fail('other');
  return gistId;
}

/** Creates the Gist with the current stock, encrypted with a new password. */
export async function createVault(
  api: GistApi,
  password: string,
  inv: Inventory,
): Promise<{ gistId: string; key: Uint8Array<ArrayBuffer>; salt: string; iterations: number }> {
  const salt = toBase64(randomBytes(16));
  const key = await deriveKey(password, fromBase64(salt), ITERATIONS);
  const gistId = await api.create(await seal(key, salt, ITERATIONS, inv));
  if (!gistId) throw fail('other');
  return { gistId, key, salt, iterations: ITERATIONS };
}

// ---- pairing link ------------------------------------------------------------------------------

const PAIR = 'verbinden=';

/** A link that connects another device: it carries the token and the Gist, not the password. */
export function pairingLink(base: string, cfg: Pick<SyncConfig, 'token' | 'gistId'>): string {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ t: cfg.token, g: cfg.gistId })));
  return `${base.split('#')[0]}#${PAIR}${payload}`;
}

/** Reads a pairing link (or just its fragment). Null when the text is something else. */
export function parsePairing(text: string): { token: string; gistId: string } | null {
  const i = text.indexOf(PAIR);
  if (i < 0 || (i > 0 && text[i - 1] !== '#')) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(fromBase64(text.slice(i + PAIR.length).trim()))) as { t?: unknown; g?: unknown };
    if (typeof v.t === 'string' && typeof v.g === 'string' && v.t && v.g) return { token: v.t, gistId: v.g };
  } catch {
    // Not a pairing link after all.
  }
  return null;
}

// ---- the running sync --------------------------------------------------------------------------

export type SyncState =
  | { phase: 'syncing' }
  | { phase: 'ok'; at: number }
  | { phase: 'error'; error: SyncError; at: number | null };

export interface LocalStock {
  get(): Inventory;
  /** Takes in a merged stock. Must merge it with whatever changed locally meanwhile. */
  apply(merged: Inventory): void;
}

export class SyncEngine {
  private running: Promise<void> | null = null;
  private again = false;
  private etag: string | undefined;
  private remote: Inventory | null = null;
  private timer = 0;
  private lastOk: number | null = null;
  private key: Uint8Array<ArrayBuffer>;

  constructor(
    readonly config: SyncConfig,
    private api: GistApi,
    private local: LocalStock,
    private onState: (s: SyncState) => void,
  ) {
    this.key = fromBase64(config.key);
  }

  private get salt(): string {
    return this.config.salt;
  }
  private get iterations(): number {
    return this.config.iterations;
  }

  /** Syncs now; calls while one runs are folded into one more run afterwards. */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.once();
      } while (this.again);
    })().finally(() => (this.running = null));
    return this.running;
  }

  /** Syncs shortly after a local change, so a burst of scans goes up in one write. */
  soon(delayMs = 1500): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.sync(), delayMs) as unknown as number;
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  private async once(): Promise<void> {
    this.onState({ phase: 'syncing' });
    try {
      const r = await this.api.read(this.config.gistId, this.remote ? this.etag : undefined);
      if (r !== 'unchanged') {
        this.remote = await open(this.key, r.envelope);
        this.etag = r.etag ?? undefined;
      }
      const remote = this.remote!;
      const merged = merge(this.local.get(), remote);
      if (!sameContent(merged, this.local.get())) this.local.apply(merged);
      if (!sameContent(merged, remote)) {
        await this.api.write(this.config.gistId, await seal(this.key, this.salt, this.iterations, merged));
        this.remote = merged;
        this.etag = undefined;
      }
      this.lastOk = Date.now();
      this.onState({ phase: 'ok', at: this.lastOk });
    } catch (err) {
      const error = err instanceof SyncError ? err : new SyncError('other', MESSAGES.other);
      this.onState({ phase: 'error', error, at: this.lastOk });
    }
  }
}
