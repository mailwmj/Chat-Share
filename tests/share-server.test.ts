// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { shareSession, uploadShare, resolveToken, ghToken } from '../server/share';
import { execFile } from 'node:child_process';
import contribute from '../index.server';
import { MAX_SHARE_BYTES, SHARE_FILENAME } from '../shared/format';
import { maliciousShare, session, snapshot, entry } from './fixtures';
import type { PluginServerContext } from '@getpaseo/plugin/server';

const token = 'synthetic-TOKEN-secret-DO-NOT-RETURN';
const id = 'a'.repeat(32);
const settings = { viewerUrl: 'https://viewer.example/base/', fallbackToken: 'synthetic-fallback' };
const ok = () => new Response(JSON.stringify({ id, public: false, owner: { login: 'response-owner' } }), { status: 201 });
const timeline = () => ({ ...snapshot, entries: [entry({ type: 'assistant_message', text: 'synthetic full output' })],
  reset: false, gap: false, staleCursor: false, hasOlder: false, hasNewer: false, startCursor: { epoch: snapshot.epoch, seq: 1 }, error: null });
const source = () => Promise.resolve({ session, refetch: vi.fn().mockResolvedValue(timeline()) });
vi.mock('node:child_process', () => ({ execFile: vi.fn((_file, _args, _options, callback) => callback(null, 'synthetic-TOKEN-secret-DO-NOT-RETURN\n')) }));

describe('private, complete Gist upload', () => {
  it('uploads a complete snapshot as a secret Gist and builds the link from response owner.login', async () => {
    const fetch = vi.fn().mockResolvedValue(ok()), readGh = vi.fn().mockResolvedValue(token);
    const result = await shareSession(settings, source, { fetch, readGh });
    expect(result).toEqual({ url: `https://viewer.example/base/#response-owner/${id}` });
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/gists'); expect(request.method).toBe('POST');
    expect(request.headers.Authorization).toBe(`Bearer ${token}`);
    const body = JSON.parse(request.body);
    expect(body.public).toBe(false); expect(Object.keys(body.files)).toEqual([SHARE_FILENAME]);
    expect(body.description).not.toContain(session.title); expect(body.description).not.toContain('synthetic full output');
    const content = JSON.parse(body.files[SHARE_FILENAME].content);
    expect(content.entries).toEqual(timeline().entries); expect(content.snapshot).toEqual(snapshot);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['', 'ftp://viewer.example', 'https://user:pass@viewer.example', 'https://viewer.example/#bad', 'https://viewer.example/?token=x'])('fails before snapshot/credentials/network for an unconfigured or invalid viewer (%s)', async viewerUrl => {
    const fetch = vi.fn(), readGh = vi.fn(), getSource = vi.fn(source);
    await expect(shareSession({ ...settings, viewerUrl }, getSource, { fetch, readGh })).rejects.toThrow('未配置查看器');
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

describe('server credential order', () => {
  it('invokes gh directly with no shell', async () => {
    expect(await ghToken()).toBe(token);
    expect(execFile).toHaveBeenLastCalledWith('gh', ['auth', 'token'], expect.objectContaining({ encoding: 'utf8' }), expect.any(Function));
    expect(vi.mocked(execFile).mock.calls.at(-1)![2]).not.toHaveProperty('shell');
  });
  it('prefers gh over a configured fallback', async () => {
    expect(await resolveToken('fallback', async () => ` ${token}\n`)).toBe(token);
  });
  it.each(['empty', 'failure'])('uses the fallback when gh returns %s', async kind => {
    expect(await resolveToken(' fallback ', async () => { if (kind === 'failure') throw new Error(token); return ''; })).toBe('fallback');
  });
  it('reports how to log in when neither source supplies a token', async () => {
    const fetch = vi.fn();
    await expect(uploadShare(maliciousShare(), { ...settings, fallbackToken: '' }, { fetch, readGh: async () => '' })).rejects.toThrow('gh auth login');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('plugin RPC wiring', () => {
  it('registers persisted settings and reads the selected daemon agent through the complete snapshot pipeline', async () => {
    const registerSettings = vi.fn().mockReturnValue({ read: async () => ({ status: 'ready', values: settings }) });
    const handle = vi.fn(); contribute({ registerSettings, handle } as unknown as PluginServerContext);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    const data = { ...session, archivedAt: null };
    const refresh = vi.fn().mockResolvedValue({ agent: data }), refetch = vi.fn().mockResolvedValue(timeline());
    const ref = vi.fn().mockReturnValue({ refresh, timeline: { refetch } });
    const result = await handle.mock.calls[0]![1]({ agentId: 'chosen' }, { paseo: { agents: { ref } } });
    expect(result).toEqual({ url: `https://viewer.example/base/#response-owner/${id}` });
    expect(ref).toHaveBeenCalledExactlyOnceWith('chosen'); expect(refresh).toHaveBeenCalledOnce();
    expect(refetch).toHaveBeenCalledExactlyOnceWith({ direction: 'tail', limit: 0, projection: 'projected' });
    expect(fetch).toHaveBeenCalledOnce(); fetch.mockClear(); ref.mockClear();
    // A missing URL must fail before the RPC even looks up the agent.
    registerSettings.mock.results[0]!.value.read = async () => ({ status: 'ready', values: { ...settings, viewerUrl: '' } });
    await expect(handle.mock.calls[0]![1]({ agentId: 'chosen' }, { paseo: { agents: { ref } } })).rejects.toThrow('未配置查看器');
    expect(registerSettings).toHaveBeenCalledOnce(); expect(ref).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
});
