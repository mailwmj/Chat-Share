import { PBKDF2_ITERATIONS, ShareError, parseShare, type LockedShare, type ShareDocument } from './format';

/*
 * The Gist can be fetched by anyone holding its link, so a password can be guessed offline and
 * six digits only slow that down. This keeps the content off GitHub in readable form; it does not
 * stop someone determined to try every code.
 */

export function encodeBytes(bytes: Uint8Array): string {
  let binary = '';
  // Spreading all of a large buffer into one call would overflow the argument limit.
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

export function decodeBytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text), bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function deriveShareKey(password: string, salt: string): Promise<Uint8Array<ArrayBuffer>> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: decodeBytes(salt), iterations: PBKDF2_ITERATIONS }, material, 256));
}

export async function lockContent(content: string, password: string): Promise<string> {
  const salt = encodeBytes(crypto.getRandomValues(new Uint8Array(16))), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', await deriveShareKey(password, salt), 'AES-GCM', false, ['encrypt']);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(content));
  const locked: LockedShare = {
    version: 2,
    kdf: { name: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt },
    cipher: { name: 'AES-256-GCM', iv: encodeBytes(iv) },
    data: encodeBytes(new Uint8Array(data)),
  };
  return JSON.stringify(locked);
}

/** A wrong password and altered data both fail the GCM tag, so both report 'password'. */
export async function openLockedShare(locked: LockedShare, derivedKey: Uint8Array<ArrayBuffer>): Promise<ShareDocument> {
  const key = await crypto.subtle.importKey('raw', derivedKey, 'AES-GCM', false, ['decrypt']);
  let plain: ArrayBuffer;
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decodeBytes(locked.cipher.iv) }, key, decodeBytes(locked.data)); }
  catch { throw new ShareError('password'); }
  return parseShare(new TextDecoder().decode(plain));
}

/** Keeps typed digits, and takes the code from a pasted "链接 + 密码：123456" message. Digits inside a link never count. */
export function passwordDigits(value: string): string {
  const text = value.replace(/[!-~]*:\/\/[!-~]*/g, '');
  const pasted = /(?:^|\D)(\d{6})\s*$/.exec(text);
  return pasted ? pasted[1]! : text.replace(/\D/g, '').slice(0, 6);
}
