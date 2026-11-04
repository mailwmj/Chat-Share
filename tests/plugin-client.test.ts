import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PluginButtonContentProps, PluginClientContext } from '@getpaseo/plugin/client';
import { registerHeaders } from '../client/header';
import { createSharePopover } from '../client/share-popover';
import { observeDirectory } from '../client/directory';

const host = vi.hoisted(() => ({ rpc: vi.fn(), lookup: vi.fn(), timeline: vi.fn(), list: vi.fn(), copy: vi.fn(), toast: { show: vi.fn(), error: vi.fn() } }));
vi.mock('@getpaseo/plugin/client', () => {
  const api = { agents: { list: host.list, ref: (id: string) => ({ timeline: host.timeline(id) }) } };
  return { usePaseo: () => api, useRpc: (contract: { name: string }) => contract.name === 'list-shares' ? host.lookup : host.rpc };
});
vi.mock('@getpaseo/plugin/client/ui', async () => {
  const { createElement } = await import('react');
  return {
    copyText: host.copy, useToast: () => host.toast, Icon: () => null,
    ScrollView: ({ children }: { children: unknown }) => createElement('div', null, children as never),
  };
});
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const View = ({ children, accessibilityLabel }: { children?: unknown; accessibilityLabel?: string }) => createElement('div', { 'aria-label': accessibilityLabel }, children as never);
  const finish = () => ({ start: (done?: () => void) => done?.(), stop: () => {} });
  return {
    View,
    Text: ({ children, numberOfLines }: { children: unknown; numberOfLines?: number }) => createElement('span', { 'data-lines': numberOfLines }, children as never),
    Pressable: ({ children, onPress, disabled, accessibilityLabel, accessibilityState }: { children: unknown; onPress: () => void; disabled?: boolean; accessibilityLabel: string; accessibilityState?: { selected?: boolean } }) =>
      createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel, 'aria-selected': accessibilityState?.selected }, children as never),
    ActivityIndicator: () => null,
    AccessibilityInfo: { isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove: () => {} }) },
    Animated: { View, Value: class { setValue() {} interpolate() { return this; } }, timing: finish, loop: finish },
    Easing: { linear: (t: number) => t, bezier: () => (t: number) => t, out: (f: unknown) => f, back: () => (t: number) => t },
    Platform: { OS: 'web' },
  };
});

type Observer = { snapshot: (data: unknown) => void; update: (data: unknown) => void };
function directory() {
  let observer: Observer;
  const release = vi.fn().mockResolvedValue(undefined);
  const subscription = { subscribe: vi.fn((next: Observer) => { observer = next; }), release };
  return { subscription, release, snapshot: (data: unknown) => observer.snapshot({ pageInfo: { nextCursor: null }, ...(data as object) }), update: (data: unknown) => observer.update(data) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren(); vi.resetAllMocks(); });

describe('header registration follows the workspace directory', () => {
  it('registers existing and later workspaces, removes archived ones, reconciles reconnects, and releases on cleanup', async () => {
    const dir = directory();
    const list = vi.fn().mockResolvedValue(dir), registrations = new Map<string, { remove: ReturnType<typeof vi.fn> }>();
    const addHeaderButton = vi.fn(({ workspaceId }) => {
      const registration = { remove: vi.fn() }; registrations.set(workspaceId, registration); return registration;
    });
    const cleanup = registerHeaders({ paseo: { workspaces: { list } }, addHeaderButton } as unknown as PluginClientContext, () => null);
    await Promise.resolve();
    expect(list.mock.calls[0]![0]).toMatchObject({ subscribe: {} });
    dir.snapshot({ entries: [{ id: 'first' }, { id: 'second' }] });
    dir.update({ type: 'workspace_update', payload: { kind: 'upsert', workspace: { id: 'later' } } });
    dir.update({ type: 'workspace_update', payload: { kind: 'upsert', workspace: { id: 'later' } } });
    expect(addHeaderButton.mock.calls.map(([value]) => value.workspaceId)).toEqual(['first', 'second', 'later']);
    dir.update({ type: 'workspace_update', payload: { kind: 'remove', id: 'second' } });
    expect(registrations.get('second')!.remove).toHaveBeenCalledOnce();
    dir.snapshot({ entries: [{ id: 'later' }, { id: 'after-reconnect' }] });
    expect(registrations.get('first')!.remove).toHaveBeenCalledOnce();
    expect(registrations.has('after-reconnect')).toBe(true);
    cleanup(); expect(dir.release).toHaveBeenCalledOnce();
    expect(registrations.get('later')!.remove).toHaveBeenCalledOnce();
    dir.update({ type: 'workspace_update', payload: { kind: 'upsert', workspace: { id: 'too-late' } } });
    expect(registrations.has('too-late')).toBe(false);
  });
  it('releases an observation that finishes bootstrapping after teardown', async () => {
    const pending = deferred<ReturnType<typeof directory>>(), dir = directory(), addHeaderButton = vi.fn();
    const cleanup = registerHeaders({ paseo: { workspaces: { list: () => pending.promise } }, addHeaderButton } as unknown as PluginClientContext, () => null);
    cleanup(); pending.resolve(dir); await Promise.resolve();
    expect(dir.release).toHaveBeenCalledOnce(); expect(dir.subscription.subscribe).not.toHaveBeenCalled(); expect(addHeaderButton).not.toHaveBeenCalled();
  });
});

describe('complete directory observation', () => {
  it('loads later pages and applies changes arriving during pagination after the snapshot', async () => {
    const dir = directory(), next = deferred<{ entries: string[]; pageInfo: { nextCursor: null } }>();
    const list = vi.fn().mockResolvedValueOnce(dir).mockReturnValueOnce(next.promise);
    const snapshot = vi.fn(), update = vi.fn(), error = vi.fn();
    const stop = observeDirectory(list, { snapshot, update, error }); await Promise.resolve();
    dir.snapshot({ entries: ['first'], pageInfo: { nextCursor: 'cursor-2' } });
    const message = { type: 'workspace_update', payload: { kind: 'remove', id: 'first' } };
    dir.update(message); expect(snapshot).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
    next.resolve({ entries: ['second'], pageInfo: { nextCursor: null } }); await Promise.resolve();
    expect(list.mock.calls).toEqual([[undefined, true], ['cursor-2', false]]);
    expect(snapshot).toHaveBeenCalledExactlyOnceWith(['first', 'second']); expect(update).toHaveBeenCalledExactlyOnceWith(message);
    expect(error).not.toHaveBeenCalled(); stop();
  });
  it('does not let a stale page overwrite a newer reconnect snapshot', async () => {
    const dir = directory(), stale = deferred<{ entries: string[]; pageInfo: { nextCursor: null } }>();
    const list = vi.fn().mockResolvedValueOnce(dir).mockReturnValueOnce(stale.promise), snapshot = vi.fn();
    const stop = observeDirectory(list, { snapshot, update: vi.fn(), error: vi.fn() }); await Promise.resolve();
    dir.snapshot({ entries: ['old'], pageInfo: { nextCursor: 'old-cursor' } });
    dir.snapshot({ entries: ['fresh'] }); stale.resolve({ entries: ['stale-page'], pageInfo: { nextCursor: null } }); await Promise.resolve();
    expect(snapshot).toHaveBeenCalledExactlyOnceWith(['fresh']); stop();
  });
});

const version = { epoch: 'timeline-1', maxSeq: 10 };
const shared = (id = 'a', maxSeq = 10) => ({ url: `https://viewer.example/#synthetic/${id.repeat(32)}`, version: { ...version, maxSeq } });
const agent = (id = 'a', title = 'First', updatedAt = '2026-11-03T10:00:00Z', createdAt = '2026-11-01T10:00:00Z') => ({ id, title, provider: 'codex', workspaceId: 'current', updatedAt, createdAt });

function timeline(maxSeq = 10, epoch = version.epoch) {
  let listener: (event: unknown) => void;
  const stop = Object.assign(vi.fn(), { ready: Promise.resolve() });
  return {
    refetch: vi.fn().mockResolvedValue({ epoch, window: { maxSeq }, error: null, gap: false, reset: false, staleCursor: false }),
    subscribe: vi.fn((next: typeof listener) => { listener = next; return stop; }),
    emit: (seq: number, currentEpoch = epoch) => listener({ event: { type: 'timeline' }, seq, epoch: currentEpoch }),
    notify: (type: string) => listener({ event: { type } }),
    stop,
  };
}
async function mountPopover(entries: Array<ReturnType<typeof agent> & { archivedAt?: string }> = [agent()], Content = createSharePopover()) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const dir = directory(); host.list.mockResolvedValue(dir);
  if (!host.lookup.getMockImplementation()) host.lookup.mockResolvedValue({ links: {} });
  if (!host.timeline.getMockImplementation()) host.timeline.mockReturnValue(timeline());
  const node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(async () => root!.render(createElement(Content,
    { workspaceId: 'current', theme: { colors: {} }, layout: { compact: false, platform: 'web' } } as PluginButtonContentProps)));
  await act(async () => dir.snapshot({ entries: entries.map(agent => ({ agent })) }));
  const button = (label: string) => node.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const click = async (label: string) => { await act(async () => button(label).click()); };
  return { node, dir, button, click };
}

describe('share popover', () => {
  it.each(['typed failure', 'wrapped transport failure'])('shows only a short message for a %s', async kind => {
    const short = '请在服务器安装 GitHub CLI（gh），并运行 gh auth login 登录。';
    if (kind === 'typed failure') host.rpc.mockResolvedValueOnce({ error: short });
    else host.rpc.mockRejectedValueOnce(new Error('Request failed: token requestType=plugin.rpc.invoke.request code=handler_error'));
    const expected = kind === 'typed failure' ? short : '分享失败，请稍后重试。';
    const { node, click } = await mountPopover();
    await click('分享 First');
    expect(host.toast.error).toHaveBeenCalledExactlyOnceWith(expected);
    expect(node.textContent).toContain(expected);
    expect(node.textContent).not.toContain('requestType=');
    expect(host.copy).not.toHaveBeenCalled();
  });
  it('shares each row independently, prevents duplicate uploads, and preserves a selectable link when copying fails', async () => {
    const first = deferred<ReturnType<typeof shared>>(), second = deferred<ReturnType<typeof shared>>();
    host.rpc.mockImplementation(({ agentId }) => agentId === 'a' ? first.promise : second.promise);
    host.copy.mockRejectedValue(new Error('clipboard denied'));
    const { node, button, click } = await mountPopover([agent(), agent('b', 'Second'), { ...agent('x', 'Elsewhere'), workspaceId: 'other' }, { ...agent('z', 'Archived'), archivedAt: 'yesterday' }]);
    expect(node.textContent).not.toContain('Elsewhere'); expect(node.textContent).not.toContain('Archived');
    expect(node.querySelector('[aria-label="codex"]')).not.toBeNull();
    await act(async () => { button('分享 First').click(); button('分享 First').click(); });
    expect(button('正在创建 First 的分享链接').disabled).toBe(true);
    expect(button('分享 Second').disabled).toBe(false);
    await click('分享 Second');
    expect(host.rpc.mock.calls).toEqual([[{ agentId: 'a' }], [{ agentId: 'b' }]]);
    await act(async () => first.resolve(shared()));
    expect(host.copy).toHaveBeenCalledExactlyOnceWith(shared().url);
    expect(node.textContent).toContain(shared().url);
    expect(button('复制 First 的链接').disabled).toBe(false);
    host.copy.mockResolvedValue(undefined);
    await click('复制 First 的链接');
    expect(host.rpc).toHaveBeenCalledTimes(2);
    expect(host.toast.show).toHaveBeenCalledWith('链接已复制', { variant: 'success' });
    await act(async () => new Promise(done => setTimeout(done, 180)));
    expect(node.textContent).not.toContain(shared().url);
    await act(async () => second.resolve(shared('b')));
  });
  it('orders agents by creation like the tab strip, and activity does not move them', async () => {
    const { node, dir } = await mountPopover([agent('new', 'Newer', '2026-11-03T08:00:00Z', '2026-11-02T00:00:00Z'), agent('old', 'Older', '2026-11-03T09:00:00Z', '2026-11-01T00:00:00Z')]);
    const titles = () => Array.from(node.querySelectorAll('button')).map(button => button.getAttribute('aria-label'));
    expect(titles()).toEqual(['分享 Older', '分享 Newer']);
    await act(async () => dir.update({ type: 'agent_update', payload: { kind: 'upsert', agent: agent('new', 'Newer', '2026-11-03T10:00:00Z', '2026-11-02T00:00:00Z') } }));
    expect(titles()).toEqual(['分享 Older', '分享 Newer']);
  });
  it('reuses a preloaded lookup instead of waiting on a second one when opened during it', async () => {
    const preload = deferred<{ links: Record<string, ReturnType<typeof shared>> }>();
    const { button } = await mountPopover([agent()], createSharePopover(() => preload.promise));
    expect(button('正在检查 First 的分享状态')).not.toBeNull();
    expect(host.lookup).not.toHaveBeenCalled();
    await act(async () => preload.resolve({ links: { a: shared() } }));
    expect(button('复制 First 的链接')).not.toBeNull();
  });
  it('opens with a finished preload, then revalidates in the background', async () => {
    const Content = createSharePopover(async () => ({ links: { a: shared() } })), lookup = deferred<{ links: object }>();
    await Promise.resolve();
    host.lookup.mockReturnValue(lookup.promise);
    const live = timeline(); host.timeline.mockReturnValue(live);
    const { button } = await mountPopover([agent()], Content);
    expect(host.lookup).toHaveBeenCalledOnce();
    expect(button('复制 First 的链接')).not.toBeNull();
    await act(async () => lookup.resolve({ links: {} }));
    expect(button('分享 First')).not.toBeNull();
  });
  it('reopens with the last rows and check, and an unchanged lookup does not restart the check', async () => {
    const live = timeline(); host.timeline.mockReturnValue(live); host.lookup.mockResolvedValue({ links: { a: shared() } });
    const Content = createSharePopover();
    await mountPopover([agent()], Content);
    await act(async () => root!.unmount()); root = undefined;
    const lookup = deferred<{ links: object }>(), read = deferred<unknown>();
    host.lookup.mockReturnValue(lookup.promise); live.refetch.mockReturnValue(read.promise); live.refetch.mockClear();
    host.list.mockReturnValue(new Promise(() => {}));
    const node = document.createElement('div'); document.body.append(node); root = createRoot(node);
    await act(async () => root!.render(createElement(Content, { workspaceId: 'current', theme: { colors: {} }, layout: { compact: false, platform: 'web' } } as PluginButtonContentProps)));
    const button = (label: string) => node.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button('复制 First 的链接')).not.toBeNull();
    await act(async () => lookup.resolve({ links: { a: shared() } }));
    expect(live.refetch).toHaveBeenCalledOnce();
    await act(async () => read.resolve({ epoch: version.epoch, window: { maxSeq: 11 } }));
    expect(button('复制 First 的链接')).toBeNull();
    expect(button('重新生成 First 的分享')).not.toBeNull();
  });
  it('withdraws a remembered copy action when the check on reopen fails', async () => {
    const live = timeline(); host.timeline.mockReturnValue(live); host.lookup.mockResolvedValue({ links: { a: shared() } });
    const Content = createSharePopover();
    await mountPopover([agent()], Content);
    await act(async () => root!.unmount()); root = undefined;
    live.refetch.mockRejectedValue(new Error('offline'));
    const { node, button } = await mountPopover([agent()], Content);
    expect(button('复制 First 的链接')).toBeNull();
    expect(node.textContent).toContain('无法确认快照是否最新');
  });
  it('copies an existing snapshot, ignores title changes, and replaces copying with regeneration when content arrives', async () => {
    const live = timeline(); host.timeline.mockReturnValue(live); host.lookup.mockResolvedValue({ links: { a: shared() } });
    host.copy.mockResolvedValue(undefined);
    const { node, dir, button, click } = await mountPopover();
    await click('复制 First 的链接'); expect(host.rpc).not.toHaveBeenCalled();
    await act(async () => dir.update({ type: 'agent_update', payload: { kind: 'upsert', agent: agent('a', 'Renamed', '2026-11-03T11:00:00Z') } }));
    expect(button('复制 Renamed 的链接')).not.toBeNull();
    await act(async () => live.emit(11));
    expect(button('复制 Renamed 的链接')).toBeNull();
    expect(button('重新生成 Renamed 的分享')).not.toBeNull();
    host.rpc.mockResolvedValue(shared('b', 11));
    live.refetch.mockResolvedValue({ epoch: version.epoch, window: { maxSeq: 11 } });
    await click('重新生成 Renamed 的分享');
    expect(host.rpc).toHaveBeenCalledExactlyOnceWith({ agentId: 'a' });
    expect(button('复制 Renamed 的链接')).not.toBeNull();
    expect(button('重新生成 Renamed 的分享')).toBeNull();
  });
  it.each(['new content', 'history reset'])('detects %s that arrived while closed and cleans up live subscriptions', async kind => {
    const live = timeline(kind === 'new content' ? 11 : 10, kind === 'history reset' ? 'new-epoch' : version.epoch);
    host.timeline.mockReturnValue(live); host.lookup.mockResolvedValue({ links: { a: shared() } });
    const { button } = await mountPopover();
    expect(button('重新生成 First 的分享')).not.toBeNull();
    expect(button('复制 First 的链接')).toBeNull();
    await act(async () => root!.unmount()); root = undefined;
    expect(live.stop).toHaveBeenCalledOnce();
  });
  it('keeps regeneration visible when messages arrive during upload', async () => {
    const live = timeline(12); host.timeline.mockReturnValue(live);
    const upload = deferred<ReturnType<typeof shared>>(); host.rpc.mockReturnValue(upload.promise);
    const { button, click } = await mountPopover(); await click('分享 First');
    await act(async () => upload.resolve(shared('a', 11)));
    expect(button('重新生成 First 的分享')).not.toBeNull();
    expect(button('复制 First 的链接')).toBeNull();
  });
  it('does not let an in-flight history read overwrite a newer live event', async () => {
    const live = timeline(), read = deferred<unknown>(); live.refetch.mockReturnValue(read.promise);
    host.timeline.mockReturnValue(live); host.lookup.mockResolvedValue({ links: { a: shared() } });
    const { button } = await mountPopover();
    expect(button('正在检查 First 的分享状态').disabled).toBe(true);
    await act(async () => { live.emit(11); read.resolve({ epoch: version.epoch, window: { maxSeq: 10 } }); });
    expect(button('重新生成 First 的分享')).not.toBeNull();
    expect(button('复制 First 的链接')).toBeNull();
  });
  it('checks missed content after reconnect and invalidates a replaced history immediately', async () => {
    const live = timeline(); host.timeline.mockReturnValue(live); host.lookup.mockResolvedValue({ links: { a: shared() } });
    const { button } = await mountPopover();
    expect(button('复制 First 的链接')).not.toBeNull();
    live.refetch.mockResolvedValue({ epoch: version.epoch, window: { maxSeq: 11 } });
    await act(async () => live.notify('subscription_restored'));
    expect(button('重新生成 First 的分享')).not.toBeNull();
    await act(async () => live.notify('replacement'));
    expect(button('复制 First 的链接')).toBeNull();
  });
  it('explains a failed freshness check instead of offering an unverified copy action', async () => {
    const live = timeline(); live.refetch.mockRejectedValue(new Error('offline'));
    host.timeline.mockReturnValue(live); host.lookup.mockResolvedValue({ links: { a: shared() } });
    const { node, button } = await mountPopover();
    expect(button('复制 First 的链接')).toBeNull();
    expect(button('重新生成 First 的分享')).not.toBeNull();
    expect(node.textContent).toContain('无法确认快照是否最新');
  });
  it('drops the unverifiable message when a lookup removes the link', async () => {
    const live = timeline(); live.refetch.mockRejectedValue(new Error('offline')); host.timeline.mockReturnValue(live);
    const Content = createSharePopover(async () => ({ links: { a: shared() } })), lookup = deferred<{ links: object }>();
    await Promise.resolve();
    host.lookup.mockReturnValue(lookup.promise);
    const { node, button } = await mountPopover([agent()], Content);
    expect(node.textContent).toContain('无法确认快照是否最新');
    await act(async () => lookup.resolve({ links: {} }));
    await act(async () => new Promise(done => setTimeout(done, 180)));
    expect(button('分享 First')).not.toBeNull();
    expect(node.textContent).not.toContain('无法确认快照是否最新');
  });
  it('keeps an upload across closing and reopening without copying over the clipboard while closed', async () => {
    const Content = createSharePopover(), upload = deferred<ReturnType<typeof shared>>(); host.rpc.mockReturnValue(upload.promise);
    const first = await mountPopover([agent()], Content); await first.click('分享 First');
    await act(async () => root!.unmount()); root = undefined;
    const second = await mountPopover([agent()], Content);
    expect(second.button('正在创建 First 的分享链接').disabled).toBe(true);
    await act(async () => upload.resolve(shared()));
    expect(second.button('复制 First 的链接')).not.toBeNull();
    expect(host.copy).not.toHaveBeenCalled();
    expect(host.rpc).toHaveBeenCalledOnce();
  });
  it('blocks duplicate sharing until lookup completes and exposes a failed lookup with retry', async () => {
    const lookup = deferred<{ error: string }>(); host.lookup.mockReturnValueOnce(lookup.promise);
    const { node, button, click } = await mountPopover();
    expect(button('正在检查 First 的分享状态').disabled).toBe(true);
    await act(async () => lookup.resolve({ error: '读取分享链接失败，请稍后重试。' }));
    expect(node.textContent).toContain('读取分享链接失败');
    host.lookup.mockResolvedValue({ links: { a: shared() } });
    await click('重试读取分享链接');
    expect(button('复制 First 的链接')).not.toBeNull(); expect(host.rpc).not.toHaveBeenCalled();
  });
  it('does not offer a stale selectable URL after a clipboard failure and a new message', async () => {
    const live = timeline(); host.timeline.mockReturnValue(live); host.lookup.mockResolvedValue({ links: { a: shared() } });
    host.copy.mockRejectedValue(new Error('denied'));
    const { node, click } = await mountPopover(); await click('复制 First 的链接');
    expect(node.textContent).toContain(shared().url);
    await act(async () => live.emit(11));
    await act(async () => new Promise(done => setTimeout(done, 180)));
    expect(node.textContent).not.toContain(shared().url);
  });
});
