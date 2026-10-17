/**
 * Encryption for the synced stock. The key is derived from the password with PBKDF2 (SHA-256,
 * 600 000 rounds as OWASP recommends) and the data is sealed with AES-GCM, so the stored file is
 * unreadable and tamper-evident without the password. Everything runs in the browser (Web Crypto).
 */

export const ITERATIONS = 600_000;
const AAD = new TextEncoder().encode('rolle-v1');

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const toBase64Url = (bytes: Uint8Array): string =>
  toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const randomBytes = (n: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(n));

/** The 256-bit key for a password, as raw bytes (kept on the device instead of the password). */
export async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations = ITERATIONS): Promise<Uint8Array<ArrayBuffer>> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256);
  return new Uint8Array(bits);
}

const aesKey = (raw: Uint8Array<ArrayBuffer>, use: 'encrypt' | 'decrypt') =>
  crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [use]);

export async function encryptJson(key: Uint8Array<ArrayBuffer>, value: unknown): Promise<{ iv: string; data: string }> {
  const iv = randomBytes(12);
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, await aesKey(key, 'encrypt'), plain);
  return { iv: toBase64(iv), data: toBase64(new Uint8Array(sealed)) };
}

/** Throws when the key is wrong or the data was changed. */
export async function decryptJson(key: Uint8Array<ArrayBuffer>, iv: string, data: string): Promise<unknown> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv), additionalData: AAD },
    await aesKey(key, 'decrypt'),
    fromBase64(data),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}
