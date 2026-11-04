// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decodeBytes, deriveShareKey, encodeBytes, lockContent, openLockedShare, passwordDigits } from '../shared/encryption';
import { PBKDF2_ITERATIONS, parseStoredShare, type LockedShare } from '../shared/format';
import { designShare } from './fixtures';

const password = '482913';
const lock = async () => JSON.parse(await lockContent(JSON.stringify(designShare()), password)) as LockedShare;
const open = async (locked: LockedShare, code = password) => openLockedShare(locked, await deriveShareKey(code, locked.kdf.salt));

// Deriving a key is deliberately slow; the format checks only need the shape.
const fixture: LockedShare = {
  version: 2,
  kdf: { name: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: encodeBytes(new Uint8Array(16)) },
  cipher: { name: 'AES-256-GCM', iv: encodeBytes(new Uint8Array(12)) },
  data: encodeBytes(new Uint8Array(32)),
};

describe('share encryption', () => {
  it('round-trips the whole document, with no readable metadata left around the ciphertext', async () => {
    const locked = await lock(), text = JSON.stringify(locked);
    expect(await open(locked)).toEqual(designShare());
    expect(Object.keys(locked).sort()).toEqual(['cipher', 'data', 'kdf', 'version']);
    expect(text).not.toContain(designShare().session.title);
    expect(text).not.toContain(designShare().session.cwd);
    expect(text).not.toContain(password);
  });
  it('uses a fresh salt and IV each time', async () => {
    const [first, second] = [await lock(), await lock()];
    expect(first.kdf.salt).not.toBe(second.kdf.salt); expect(first.cipher.iv).not.toBe(second.cipher.iv); expect(first.data).not.toBe(second.data);
  });
  it('rejects the wrong password', async () => {
    await expect(open(await lock(), '000000')).rejects.toThrow('password');
  });
  it('rejects altered ciphertext', async () => {
    const locked = await lock(), bytes = decodeBytes(locked.data);
    bytes[0]! ^= 1;
    await expect(open({ ...locked, data: encodeBytes(bytes) })).rejects.toThrow('password');
  });
  it('handles content far larger than one encoding chunk, including non-ASCII text', async () => {
    const content = '汉'.repeat(200_000), bytes = new TextEncoder().encode(content);
    expect(new TextDecoder().decode(decodeBytes(encodeBytes(bytes)))).toBe(content);
  });
});

describe('stored share boundary', () => {
  it('still reads an existing unencrypted share', () => {
    expect(parseStoredShare(JSON.stringify(designShare())).version).toBe(1);
  });
  it('recognises an encrypted share', async () => {
    expect(parseStoredShare(JSON.stringify(await lock())).version).toBe(2);
  });
  it.each<[string, (locked: LockedShare) => unknown]>([
    ['an expensive iteration count', locked => ({ ...locked, kdf: { ...locked.kdf, iterations: PBKDF2_ITERATIONS * 1000 } })],
    ['a cheap iteration count', locked => ({ ...locked, kdf: { ...locked.kdf, iterations: 1 } })],
    ['an unknown KDF', locked => ({ ...locked, kdf: { ...locked.kdf, name: 'MD5' } })],
    ['an unknown cipher', locked => ({ ...locked, cipher: { ...locked.cipher, name: 'ROT13' } })],
    ['a wrong salt size', locked => ({ ...locked, kdf: { ...locked.kdf, salt: 'AAAA' } })],
    ['a wrong IV size', locked => ({ ...locked, cipher: { ...locked.cipher, iv: 'AAAA' } })],
    ['non-base64 data', locked => ({ ...locked, data: '<script>' })],
    ['missing data', ({ data: _data, ...locked }) => locked],
  ])('rejects %s', (_name, change) => {
    expect(parseStoredShare(JSON.stringify(fixture)).version).toBe(2);
    expect(() => parseStoredShare(JSON.stringify(change(structuredClone(fixture))))).toThrow('invalid');
  });
});

describe('password input', () => {
  it.each([
    ['482913', '482913'],
    ['48a29', '4829'],
    ['1234567', '123456'],
    ['密码：482913', '482913'],
    ['https://chat-share.pages.dev/#owner/1234567890abcdef\n密码：482913\n', '482913'],
    ['https://chat-share.pages.dev/#owner/1234567890abcdef密码：482913', '482913'],
    ['https://chat-share.pages.dev/#local-preview/00000000000000000000000000000001', ''],
    ['https://chat-share.pages.dev/#owner/abcdef123456', ''],
    ['000123', '000123'],
    ['', ''],
  ])('reads %j as %j', (value, expected) => expect(passwordDigits(value)).toBe(expected));
});
