// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { shareSession, uploadShare, resolveToken, ghToken, listShareLinks } from '../server/share';
import { execFile } from 'node:child_process';
import contribute from '../index.server';
import { MAX_SHARE_BYTES, SHARE_FILENAME, parseStoredShare, type LockedShare } from '../shared/format';
import { deriveShareKey, openLockedShare } from '../shared/encryption';
import { filePasswordStore, type PasswordStore } from '../server/passwords';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maliciousShare, session, snapshot, entry } from './fixtures';
import type { PluginServerContext } from '@getpaseo/plugin/server';

const token = 'synthetic-TOKEN-secret-DO-NOT-RETURN';
const id = 'a'.repeat(32);
const settings = { viewerUrl: 'https://viewer.example/base/' };
const ok = () => new Response(JSON.stringify({ id, public: false, owner: { login: 'response-owner' } }), { status: 201 });
const timeline = () => ({ ...snapshot, entries: [entry({ type: 'assistant_message', text: 'synthetic full output' })],
  reset: false, gap: false, staleCursor: false, hasOlder: false, hasNewer: false, startCursor: { epoch: snapshot.epoch, seq: 1 }, error: null });
const source = () => Promise.resolve({ session, refetch: vi.fn().mockResolvedValue(timeline()) });
vi.mock('node:child_process', () => ({ execFile: vi.fn((_file, _args, _options, callback) => callback(null, 'synthetic-TOKEN-secret-DO-NOT-RETURN\n')) }));

describe('private, complete Gist upload', () => {
  it('uploads a complete snapshot as a secret Gist and builds the link from response owner.login', async () => {
    const fetch = vi.fn().mockResolvedValue(ok()), readGh = vi.fn().mockResolvedValue(token);
    const result = await shareSession(settings, source, { fetch, readGh });
    expect(result).toEqual({ url: `https://viewer.example/base/#response-owner/${id}`, version: { epoch: snapshot.epoch, maxSeq: snapshot.window.maxSeq } });
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/gists'); expect(request.method).toBe('POST');
    expect(request.headers.Authorization).toBe(`Bearer ${token}`);
    const body = JSON.parse(request.body);
    expect(body.public).toBe(false); expect(Object.keys(body.files)).toEqual([SHARE_FILENAME]);
    expect(body.description).toBe(`Chat-Share snapshot ${session.id} ${encodeURIComponent(snapshot.epoch)} ${snapshot.window.maxSeq}`);
    expect(body.description).not.toContain(session.title); expect(body.description).not.toContain('synthetic full output');
    const content = JSON.parse(body.files[SHARE_FILENAME].content);
    expect(content.entries).toEqual(timeline().entries); expect(content.snapshot).toEqual(snapshot);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['', undefined, '  '])('uses the production viewer for an empty or missing setting (%s)', async viewerUrl => {
    const fetch = vi.fn().mockResolvedValue(ok());
    await expect(shareSession({ viewerUrl }, source, { fetch, readGh: async () => token }))
      .resolves.toEqual({ url: `https://chat-share.pages.dev/#response-owner/${id}`, version: { epoch: snapshot.epoch, maxSeq: snapshot.window.maxSeq } });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(['ftp://viewer.example', 'https://user:pass@viewer.example', 'https://viewer.example/#bad', 'https://viewer.example/?token=x'])('fails before snapshot/credentials/network for an invalid viewer (%s)', async viewerUrl => {
    const fetch = vi.fn(), readGh = vi.fn(), getSource = vi.fn(source);
    await expect(shareSession({ ...settings, viewerUrl }, getSource, { fetch, readGh })).rejects.toThrow('查看器地址无效');
    expect(getSource).not.toHaveBeenCalled(); expect(readGh).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('reports UTF-8 byte size and sends no request for oversized snapshots', async () => {
    const fetch = vi.fn(), readGh = vi.fn();
    const page = timeline(); page.entries = [entry({ type: 'assistant_message', text: '汉'.repeat(3_333_334) })];
    await expect(shareSession(settings, async () => ({ session, refetch: vi.fn().mockResolvedValue(page) }), { fetch, readGh }))
      .rejects.toThrow(/会话过大：[\d,]+ 字节；上限为 10,000,000 字节/);
    expect(fetch).not.toHaveBeenCalled(); expect(readGh).not.toHaveBeenCalled();
  });
  it('also enforces the limit at the upload entry before credentials/network', async () => {
    const share = maliciousShare(); share.session.title = 'x'.repeat(MAX_SHARE_BYTES);
    const fetch = vi.fn(), readGh = vi.fn();
    await expect(uploadShare(share, settings, { fetch, readGh })).rejects.toThrow('会话过大');
    expect(fetch).not.toHaveBeenCalled(); expect(readGh).not.toHaveBeenCalled();
  });
  it('never uploads a partial snapshot after repeated timeline changes', async () => {
    const refetch = vi.fn().mockResolvedValue({ ...timeline(), gap: true }), fetch = vi.fn();
    await expect(shareSession(settings, async () => ({ session, refetch }), { fetch })).rejects.toThrow('快照失败');
    expect(refetch).toHaveBeenCalledTimes(3); expect(fetch).not.toHaveBeenCalled();
  });
  it('maps a source error without returning its possibly sensitive text', async () => {
    await expect(shareSession(settings, async () => { throw new Error(token); })).rejects.toThrow(/^读取会话快照失败/);
  });
  it.each([
    [401, {}, 'token 被拒绝'], [403, {}, 'gist 权限'], [422, {}, 'gist 权限'],
    [403, { 'x-ratelimit-remaining': '0' }, '请求受限'], [403, { 'retry-after': '20' }, '请求受限'],
    [429, {}, '请求受限'], [503, {}, '服务器网络'],
  ] as const)('sanitizes GitHub %s responses even when they echo the token', async (status, headers, expected) => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: token }), { status, headers }));
    try { await uploadShare(maliciousShare(), settings, { fetch, readGh: async () => token }); expect.fail('Expected failure'); }
    catch (error) { expect(String(error)).toContain(expected); expect(String(error)).not.toContain(token); }
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['network', 'invalid JSON', 'echo in owner', 'bad id', 'public response'])('does not return a dead link or leak a token for %s', async kind => {
    const fetch = vi.fn().mockImplementation(async () => {
      if (kind === 'network') throw new Error(token);
      if (kind === 'invalid JSON') return new Response(token);
      return new Response(JSON.stringify({ id: kind === 'bad id' ? token : id, public: kind === 'public response', owner: { login: kind === 'echo in owner' ? token : 'owner' } }));
    });
    await expect(uploadShare(maliciousShare(), settings, { fetch, readGh: async () => token })).rejects.toThrow(/^无法连接 GitHub/);
    expect(fetch).toHaveBeenCalledTimes(['echo in owner', 'public response'].includes(kind) ? 2 : 1);
  });
  it.each(['deleted', 'delete rejected', 'delete network failure'])('tries to delete a Gist after invalid response without masking the error (%s)', async cleanup => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id, public: false, owner: null })));
    if (cleanup === 'delete network failure') fetch.mockRejectedValueOnce(new Error(token));
    else fetch.mockResolvedValueOnce(new Response(null, { status: cleanup === 'deleted' ? 204 : 403 }));
    await expect(uploadShare(maliciousShare(), settings, { fetch, readGh: async () => token })).rejects.toThrow(/^无法连接 GitHub/);
    expect(fetch.mock.calls[1]![0]).toBe(`https://api.github.com/gists/${id}`);
    expect(fetch.mock.calls[1]![1]).toMatchObject({ method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  });
});

describe('encrypted upload', () => {
  const memory = (): PasswordStore & { saved: Record<string, string> } => {
    const saved: Record<string, string> = {};
    return { saved, read: async () => saved, save: async (gistId, password) => { saved[gistId] = password; } };
  };
  it('uploads nothing readable, generates a 6-digit password, and the reader can open it with that password', async () => {
    const fetch = vi.fn().mockResolvedValue(ok()), passwords = memory();
    const result = await shareSession(settings, source, { fetch, readGh: async () => token, passwords }, true);
    expect(result.locked).toBe(true); expect(result.password).toMatch(/^\d{6}$/);
    expect(passwords.saved).toEqual({ [id]: result.password });
    const body = JSON.parse(fetch.mock.calls[0]![1].body), content: string = body.files[SHARE_FILENAME].content;
    expect(body.public).toBe(false);
    expect(body.description).toBe(`Chat-Share snapshot ${session.id} ${encodeURIComponent(snapshot.epoch)} ${snapshot.window.maxSeq} locked`);
    for (const secret of [session.title, session.cwd, 'synthetic full output', result.password!]) {
      expect(content).not.toContain(secret); expect(body.description).not.toContain(secret);
    }
    const stored = parseStoredShare(content) as LockedShare;
    const opened = await openLockedShare(stored, await deriveShareKey(result.password!, stored.kdf.salt));
    expect(opened.session.title).toBe(session.title); expect(opened.entries).toEqual(timeline().entries);
  });
  it('generates a new password for each share', async () => {
    const fetch = vi.fn().mockImplementation(async () => ok());
    const shares = await Promise.all(Array.from({ length: 3 }, () => shareSession(settings, source, { fetch, readGh: async () => token, passwords: memory() }, true)));
    expect(new Set(shares.map(share => share.password)).size).toBeGreaterThan(1);
  });
  it('still returns a working password when it cannot be saved', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const passwords: PasswordStore = { read: async () => ({}), save: async () => { throw new Error(token); } };
    const result = await shareSession(settings, source, { fetch: vi.fn().mockResolvedValue(ok()), readGh: async () => token, passwords }, true);
    expect(result.password).toMatch(/^\d{6}$/);
    expect(JSON.stringify(error.mock.calls)).not.toContain(token);
    error.mockRestore();
  });
  it('does not save a password for an upload that failed', async () => {
    const passwords = memory();
    await expect(shareSession(settings, source, { fetch: vi.fn().mockResolvedValue(new Response('', { status: 503 })), readGh: async () => token, passwords }, true)).rejects.toThrow('无法连接');
    expect(passwords.saved).toEqual({});
  });
  it('says the encrypted size is what exceeded the limit, before credentials or network', async () => {
    const fetch = vi.fn(), readGh = vi.fn(), share = maliciousShare();
    share.session.title = 'x'.repeat(8_000_000);
    await expect(uploadShare(share, settings, { fetch, readGh, passwords: memory() }, '482913')).rejects.toThrow('会话加密后过大');
    expect(fetch).not.toHaveBeenCalled(); expect(readGh).not.toHaveBeenCalled();
  });
});

describe('saved share passwords', () => {
  it('survives a new store, keeps entries from simultaneous saves, and is readable only by its owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chat-share-passwords-'));
    try {
      const path = join(directory, 'nested', 'share-passwords.json'), store = filePasswordStore(path);
      expect(await store.read()).toEqual({});
      await Promise.all([store.save('first', '111111'), store.save('second', '222222')]);
      expect(await filePasswordStore(path).read()).toEqual({ first: '111111', second: '222222' });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ first: '111111', second: '222222' });
    } finally { await rm(directory, { recursive: true }); }
  });
  it.skipIf(process.getuid?.() === 0)('keeps saved passwords when the file cannot be read, instead of overwriting it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chat-share-passwords-'));
    try {
      const path = join(directory, 'share-passwords.json'), store = filePasswordStore(path);
      await store.save('first', '111111');
      await chmod(path, 0o000);
      await expect(store.read()).rejects.toThrow();
      await expect(store.save('second', '222222')).rejects.toThrow();
      await chmod(path, 0o600);
      expect(await store.read()).toEqual({ first: '111111' });
      await store.save('third', '333333');
      expect(await store.read()).toEqual({ first: '111111', third: '333333' });
    } finally { await rm(directory, { recursive: true }); }
  });
  it('treats a damaged file as empty and drops malformed entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chat-share-passwords-'));
    try {
      const path = join(directory, 'share-passwords.json'), store = filePasswordStore(path);
      await store.save('good', '111111');
      await writeFile(path, JSON.stringify({ good: '111111', short: '12', other: 5 }));
      expect(await store.read()).toEqual({ good: '111111' });
      await writeFile(path, 'not json');
      expect(await store.read()).toEqual({});
    } finally { await rm(directory, { recursive: true }); }
  });
});

describe('gh-only server credentials', () => {
  it('invokes gh directly with no shell', async () => {
    expect(await ghToken()).toBe(token);
    expect(execFile).toHaveBeenLastCalledWith('gh', ['auth', 'token'], expect.objectContaining({ encoding: 'utf8' }), expect.any(Function));
    expect(vi.mocked(execFile).mock.calls.at(-1)![2]).not.toHaveProperty('shell');
  });
  it('uses the trimmed gh token', async () => {
    expect(await resolveToken(async () => ` ${token}\n`)).toBe(token);
  });
  it.each(['empty', 'failure'])('does not upload when gh returns %s', async kind => {
    const fetch = vi.fn();
    const readGh = async () => { if (kind === 'failure') throw new Error(token); return ''; };
    await expect(uploadShare(maliciousShare(), settings, { fetch, readGh }))
      .rejects.toThrow('请在服务器安装 GitHub CLI（gh），并运行 gh auth login 登录。');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['missing', 'not logged in'])('does not upload or expose subprocess output when gh is %s', async kind => {
    vi.mocked(execFile).mockImplementationOnce((...args) => {
      const callback = args.at(-1) as (error: Error, stdout: string) => void;
      callback(Object.assign(new Error(token), { code: kind === 'missing' ? 'ENOENT' : 1 }), token);
      return {} as ReturnType<typeof execFile>;
    });
    const fetch = vi.fn();
    await expect(uploadShare(maliciousShare(), settings, { fetch }))
      .rejects.toThrow(/^请在服务器安装 GitHub CLI（gh），并运行 gh auth login 登录。$/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('plugin RPC wiring', () => {
  it('registers persisted settings and reads the selected daemon agent through the complete snapshot pipeline', async () => {
    const registerSettings = vi.fn().mockReturnValue({ read: async () => ({ status: 'ready', values: settings }) });
    const handle = vi.fn(); contribute({ registerSettings, handle } as unknown as PluginServerContext);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok());
    const data = { ...session, archivedAt: null };
    const refresh = vi.fn().mockResolvedValue({ agent: data }), refetch = vi.fn().mockResolvedValue(timeline());
    const ref = vi.fn().mockReturnValue({ refresh, timeline: { refetch } });
    const result = await handle.mock.calls[0]![1]({ agentId: 'chosen' }, { paseo: { agents: { ref } } });
    expect(result).toEqual({ url: `https://viewer.example/base/#response-owner/${id}`, version: { epoch: snapshot.epoch, maxSeq: snapshot.window.maxSeq } });
    expect(ref).toHaveBeenCalledExactlyOnceWith('chosen'); expect(refresh).toHaveBeenCalledOnce();
    expect(refetch).toHaveBeenCalledExactlyOnceWith({ direction: 'tail', limit: 0, projection: 'projected' });
    expect(fetch).toHaveBeenCalledOnce(); fetch.mockClear(); ref.mockClear();
    // Clearing a saved URL restores production without a separate save migration.
    registerSettings.mock.results[0]!.value.read = async () => ({ status: 'ready', values: { ...settings, viewerUrl: '' } });
    await expect(handle.mock.calls[0]![1]({ agentId: 'chosen' }, { paseo: { agents: { ref } } }))
      .resolves.toEqual({ url: `https://chat-share.pages.dev/#response-owner/${id}`, version: { epoch: snapshot.epoch, maxSeq: snapshot.window.maxSeq } });
    expect(registerSettings).toHaveBeenCalledOnce(); expect(ref).toHaveBeenCalledExactlyOnceWith('chosen'); expect(fetch).toHaveBeenCalledOnce();
    fetch.mockRestore();
  });
  it('returns short typed failures, including unknown errors without leaking their text', async () => {
    const read = vi.fn().mockResolvedValue({ status: 'ready', values: { viewerUrl: 'ftp://invalid' } });
    const handle = vi.fn();
    contribute({ registerSettings: () => ({ read }), handle } as unknown as PluginServerContext);
    expect(read).toHaveBeenCalledOnce();
    const handler = handle.mock.calls[0]![1], ref = vi.fn();
    await expect(handler({ agentId: 'chosen' }, { paseo: { agents: { ref } } })).resolves.toEqual({ error: '查看器地址无效，请在插件设置中修改。' });
    expect(ref).not.toHaveBeenCalled();
    read.mockRejectedValueOnce(new Error(token));
    await expect(handler({ agentId: 'chosen' }, {})).resolves.toEqual({ error: '分享失败，请稍后重试。' });
  });
});

const gist = (agentId: string, maxSeq = 12, createdAt = '2026-11-03T12:00:00Z', gistId = id) => ({
  id: gistId, public: false, owner: { login: 'owner' }, created_at: createdAt,
  description: `Chat-Share snapshot ${agentId} ${encodeURIComponent(snapshot.epoch)} ${maxSeq}`,
  files: { [SHARE_FILENAME]: { filename: SHARE_FILENAME } },
});

describe('snapshot discovery', () => {
  it('restores the latest snapshot version per conversation and ignores unrelated or malformed Gists', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify([
      gist('chosen', 12), gist('chosen', 10, '2026-11-03T11:00:00Z', 'b'.repeat(32)), gist('other', 3),
      { ...gist('public'), public: true }, { ...gist('wrong-file'), files: { 'other.json': {} } },
      { ...gist('bad-id'), id: 'not-a-gist' }, { ...gist('legacy'), description: 'Chat-Share snapshot' },
      { ...gist('bad-version'), description: 'Chat-Share snapshot chosen epoch -1' },
      { ...gist('bad-encoding'), description: 'Chat-Share snapshot chosen %E0 99' },
    ])));
    const links = await listShareLinks(settings, { fetch, readGh: async () => token });
    expect(links).toEqual({
      chosen: { url: `https://viewer.example/base/#owner/${id}`, version: { epoch: snapshot.epoch, maxSeq: 12 } },
      other: { url: `https://viewer.example/base/#owner/${id}`, version: { epoch: snapshot.epoch, maxSeq: 3 } },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(links)).not.toContain(token);
  });
  it('restores a locked link with its saved password, and without one when this machine has none', async () => {
    const lockedGist = (agentId: string, gistId: string) => ({ ...gist(agentId, 12, '2026-11-03T12:00:00Z', gistId), description: `${gist(agentId).description} locked` });
    const known = 'b'.repeat(32), unknown = 'c'.repeat(32), read = vi.fn().mockResolvedValue({ [known]: '482913' });
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify([lockedGist('known', known), lockedGist('unknown', unknown), gist('plain')])));
    const links = await listShareLinks(settings, { fetch, readGh: async () => token, passwords: { read, save: vi.fn() } });
    const version = { epoch: snapshot.epoch, maxSeq: 12 };
    expect(links).toEqual({
      known: { url: `https://viewer.example/base/#owner/${known}`, version, locked: true, password: '482913' },
      unknown: { url: `https://viewer.example/base/#owner/${unknown}`, version, locked: true },
      plain: { url: `https://viewer.example/base/#owner/${id}`, version },
    });
  });
  it('does not open the password file when no share is locked, and ignores an unknown fourth marker', async () => {
    const read = vi.fn(), other = { ...gist('other'), description: `${gist('other').description} future` };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify([gist('plain'), other])));
    const links = await listShareLinks(settings, { fetch, readGh: async () => token, passwords: { read, save: vi.fn() } });
    expect(Object.keys(links)).toEqual(['plain']); expect(read).not.toHaveBeenCalled();
  });
  it('finds older shares beyond three pages rather than reporting them as unshared', async () => {
    const unrelated = Array.from({ length: 100 }, () => ({ description: 'unrelated' }));
    const fetch = vi.fn().mockImplementation(async (url: string) => new Response(JSON.stringify(url.endsWith('page=4') ? [gist('older')] : unrelated)));
    const links = await listShareLinks(settings, { fetch, readGh: async () => token });
    expect(links.older?.version).toEqual({ epoch: snapshot.epoch, maxSeq: 12 });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it.each([401, 429, 503])('reports a failed lookup for HTTP %s without leaking the response', async status => {
    const fetch = vi.fn().mockResolvedValue(new Response(token, { status }));
    try { await listShareLinks(settings, { fetch, readGh: async () => token }); expect.fail('Expected failure'); }
    catch (error) { expect(String(error)).not.toContain(token); expect(String(error)).toMatch(/GitHub/); }
  });
  it('returns a typed lookup error instead of falsely claiming no links exist', async () => {
    const handle = vi.fn();
    contribute({ registerSettings: () => ({ read: async () => ({ status: 'ready', values: { viewerUrl: 'ftp://bad' } }) }), handle } as unknown as PluginServerContext);
    await expect(handle.mock.calls[1]![1]({})).resolves.toEqual({ error: '查看器地址无效，请在插件设置中修改。' });
  });
});
