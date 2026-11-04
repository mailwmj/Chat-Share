import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PluginButtonContentProps, PluginClientContext } from '@getpaseo/plugin/client';
import { registerHeaders } from '../client/header';
import { createSharePopover, listAllAgents } from '../client/share-popover';
import { observeDirectory } from '../client/directory';

const host = vi.hoisted(() => ({ rpc: vi.fn(), lookup: vi.fn(), listAll: vi.fn(), remove: vi.fn(), openUrl: vi.fn(), timeline: vi.fn(), list: vi.fn(), copy: vi.fn(), toast: { show: vi.fn(), error: vi.fn() } }));
vi.mock('@getpaseo/plugin/client', () => {
  const api = { agents: { list: host.list, ref: (id: string) => ({ timeline: host.timeline(id) }) } };
  const rpcs: Record<string, unknown> = { 'list-shares': host.lookup, 'list-all-shares': host.listAll, 'delete-share': host.remove, 'share-agent': host.rpc };
  return { usePaseo: () => api, useRpc: (contract: { name: string }) => rpcs[contract.name], openExternalUrl: host.openUrl };
});
vi.mock('@getpaseo/plugin/client/ui', async () => {
  const { createElement } = await import('react');
  return {
    copyText: host.copy, useToast: () => host.toast, Icon: () => null,
    ScrollView: ({ children }: { children: unknown }) => createElement('div', null, children as never),
    FlatList: ({ data, renderItem, keyExtractor }: { data: unknown[]; renderItem: (info: { item: unknown }) => unknown; keyExtractor: (item: unknown) => string }) =>
      createElement('div', null, data.map(item => createElement('div', { key: keyExtractor(item) }, renderItem({ item }) as never))),
    Modal: Object.assign(({ open, onOpenChange, children }: { open: boolean; onOpenChange(open: boolean): void; children: unknown }) =>
      open ? createElement('section', null, createElement('button', { 'aria-label': '关闭浮层', onClick: () => onOpenChange(false) }), children as never) : null,
      { Content: ({ children }: { children: unknown }) => createElement('div', null, children as never) }),
  };
});
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const View = ({ children, accessibilityLabel }: { children?: unknown; accessibilityLabel?: string }) => createElement('div', { 'aria-label': accessibilityLabel }, children as never);
  const finish = () => ({ start: (done?: () => void) => done?.(), stop: () => {} });
  return {
    View,
    Text: ({ children, numberOfLines }: { children: unknown; numberOfLines?: number }) => createElement('span', { 'data-lines': numberOfLines }, children as never),
    Pressable: ({ children, onPress, disabled, accessibilityLabel, accessibilityState }: { children: unknown; onPress: () => void; disabled?: boolean; accessibilityLabel: string; accessibilityState?: { selected?: boolean; checked?: boolean | 'mixed' } }) =>
      createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel, 'aria-selected': accessibilityState?.selected, 'aria-checked': accessibilityState?.checked }, children as never),
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
    const titles = () => Array.from(node.querySelectorAll('button[aria-label^="分享 "]')).map(button => button.getAttribute('aria-label'));
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
  it('shows preloaded rows on the first open, in tab order and only for this workspace', async () => {
    host.lookup.mockResolvedValue({ links: {} }); host.list.mockReturnValue(new Promise(() => {}));
    const Content = createSharePopover(undefined, async () => [
      agent('new', 'Newer', '2026-11-03T08:00:00Z', '2026-11-02T00:00:00Z'), agent('old', 'Older', '2026-11-03T08:00:00Z', '2026-11-01T00:00:00Z'),
      { ...agent('x', 'Elsewhere'), workspaceId: 'other' }, { ...agent('z', 'Archived'), archivedAt: 'yesterday' },
    ] as never);
    await Promise.resolve();
    const node = document.createElement('div'); document.body.append(node); root = createRoot(node);
    await act(async () => root!.render(createElement(Content, { workspaceId: 'current', theme: { colors: {} }, layout: { compact: false, platform: 'web' } } as PluginButtonContentProps)));
    expect(Array.from(node.querySelectorAll('button[aria-label^="分享 "]')).map(button => button.getAttribute('aria-label'))).toEqual(['分享 Older', '分享 Newer']);
    expect(node.querySelector('[aria-label="正在读取会话…"]')).toBeNull();
  });
  it('still loads the list on open when the agent preload fails', async () => {
    const { button } = await mountPopover([agent()], createSharePopover(undefined, async () => { throw new Error('offline'); }));
    expect(button('分享 First')).not.toBeNull();
  });
  it('preloads agents across every directory page', async () => {
    host.list.mockResolvedValueOnce({ entries: [{ agent: agent('a') }], pageInfo: { nextCursor: 'next' } }).mockResolvedValueOnce({ entries: [{ agent: agent('b') }], pageInfo: { nextCursor: null } });
    const agents = await listAllAgents({ agents: { list: host.list } } as unknown as PluginClientContext['paseo']);
    expect(agents.map(({ id }) => id)).toEqual(['a', 'b']);
    expect(host.list.mock.calls[1]![0]).toMatchObject({ page: { cursor: 'next' } });
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

describe('managing share links', () => {
  const ids = { a: 'a'.repeat(32), b: 'b'.repeat(32), c: 'c'.repeat(32) };
  const link = (gistId: string, agentId: string | undefined, createdAt: string) => ({ gistId, url: `https://viewer.example/#o/${gistId}`, createdAt, ...(agentId ? { agentId } : {}) });
  const links = [link(ids.a, 'a', '2026-11-03T10:00:00'), link(ids.b, 'a', '2026-11-01T09:05:00'), link(ids.c, 'gone', '2026-10-28T18:00:00')];
  const rows = { a: '选择 First 11月3日 10:00', b: '选择 First 11月1日 09:05', c: '选择 未命名会话 10月28日 18:00' };
  async function open(listAll: unknown = { links }) {
    host.listAll.mockResolvedValue(listAll);
    const popover = await mountPopover();
    host.list.mockResolvedValue({ entries: [{ agent: agent() }, { agent: { ...agent('z', 'Archived'), archivedAt: 'yesterday' } }], pageInfo: { nextCursor: null } });
    await popover.click('管理分享链接');
    return popover;
  }

  it('is always offered in the popover, even when this workspace has no conversations', async () => {
    const { button } = await mountPopover([]);
    expect(button('管理分享链接')).not.toBeNull();
    expect(host.listAll).not.toHaveBeenCalled();
  });
  it('lists every link newest first across workspaces, naming rows from the directory including archived agents', async () => {
    const { node, button } = await open();
    expect(host.list.mock.lastCall![0].filter).toEqual({ includeArchived: true, includeBackground: true });
    expect(Array.from(node.querySelectorAll('button[aria-label^="选择"]')).map(row => row.getAttribute('aria-label'))).toEqual([rows.a, rows.b, rows.c]);
    expect(button('删除').disabled).toBe(true);
  });
  it('still lists links under the fallback title when the directory cannot be read', async () => {
    host.listAll.mockResolvedValue({ links: [links[0]] });
    const { click, button } = await mountPopover();
    host.list.mockRejectedValue(new Error('offline'));
    await click('管理分享链接');
    expect(button('选择 未命名会话 11月3日 10:00')).not.toBeNull();
  });
  it('reads every directory page', async () => {
    host.listAll.mockResolvedValue({ links: [link(ids.c, 'later', '2026-10-28T18:00:00')] });
    const { click, button } = await mountPopover();
    host.list.mockResolvedValueOnce({ entries: [], pageInfo: { nextCursor: 'next' } })
      .mockResolvedValueOnce({ entries: [{ agent: agent('later', 'Later') }], pageInfo: { nextCursor: null } });
    await click('管理分享链接');
    expect(button('选择 Later 10月28日 18:00')).not.toBeNull();
  });
  it('shows an empty state, and a failed listing with a retry that recovers', async () => {
    const { node, click, button } = await open({ error: 'GitHub 请求受限。' });
    expect(node.textContent).toContain('GitHub 请求受限。');
    host.listAll.mockResolvedValue({ links: [] });
    await click('重试');
    expect(node.textContent).not.toContain('GitHub 请求受限。');
    expect(node.textContent).toContain('没有分享链接');
    expect(button('全选')).toBeNull();
  });
  it('selects and clears all, and reports a partial selection', async () => {
    const { button, click } = await open();
    await click(rows.a);
    expect(button('全选').getAttribute('aria-checked')).toBe('mixed');
    expect(button('删除 1 个')).not.toBeNull();
    await click('全选');
    expect(button(rows.c).getAttribute('aria-checked')).toBe('true');
    expect(button('删除 3 个')).not.toBeNull();
    await click('全选');
    expect(button(rows.a).getAttribute('aria-checked')).toBe('false');
  });
  it('deletes nothing until confirmed, and cancelling keeps the selection', async () => {
    const { node, button, click } = await open();
    await click(rows.a); await click('删除 1 个');
    expect(host.remove).not.toHaveBeenCalled();
    expect(node.textContent).toContain('无法恢复');
    expect(button(rows.b).disabled).toBe(true);
    await click('取消');
    expect(host.remove).not.toHaveBeenCalled();
    expect(button(rows.a).getAttribute('aria-checked')).toBe('true');
  });
  it('deletes one at a time with a pause, removes finished rows, leaves unselected ones, and refreshes the popover links', async () => {
    vi.useFakeTimers();
    try {
      const { node, button, click } = await open();
      await click(rows.a); await click(rows.b);
      host.remove.mockResolvedValue({ deleted: true }); host.lookup.mockClear();
      await click('删除 2 个'); await click('确认删除');
      expect(host.remove.mock.calls).toEqual([[{ gistId: ids.a }]]);
      expect(button(rows.a)).toBeNull();
      expect(node.textContent).toContain('正在删除');
      await act(async () => vi.advanceTimersByTimeAsync(999));
      expect(host.remove).toHaveBeenCalledOnce();
      expect(host.lookup).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(host.remove.mock.calls[1]).toEqual([{ gistId: ids.b }]);
      expect(button(rows.b)).toBeNull();
      expect(button(rows.c).getAttribute('aria-checked')).toBe('false');
      expect(node.textContent).not.toContain('正在删除');
      expect(host.lookup).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it.each([['a typed failure', { error: 'GitHub 请求受限。请等待限流解除后重试。' }, 'GitHub 请求受限。'], ['a transport failure', new Error('requestType=plugin.rpc'), '删除失败，请稍后重试。']])('stops at %s, keeping what was not deleted selected for a retry', async (_kind, failure, shown) => {
    vi.useFakeTimers();
    try {
      const { node, button, click } = await open();
      await click('全选');
      host.remove.mockResolvedValueOnce({ deleted: true });
      if (failure instanceof Error) host.remove.mockRejectedValueOnce(failure); else host.remove.mockResolvedValueOnce(failure);
      host.lookup.mockClear();
      await click('删除 3 个'); await click('确认删除');
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(host.remove).toHaveBeenCalledTimes(2);
      expect(node.textContent).toContain(shown);
      expect(node.textContent).not.toContain('requestType=');
      expect(button(rows.a)).toBeNull();
      expect(button(rows.b).getAttribute('aria-checked')).toBe('true');
      expect(button(rows.c).getAttribute('aria-checked')).toBe('true');
      expect(host.lookup).toHaveBeenCalledOnce();
      host.remove.mockReset(); host.remove.mockResolvedValue({ deleted: true });
      await click('删除 2 个'); await click('确认删除');
      expect(host.remove.mock.calls[0]).toEqual([{ gistId: ids.b }]);
      await act(async () => vi.advanceTimersByTimeAsync(5000));
    } finally { vi.useRealTimers(); }
  });
  it('closing the popover stops the batch after the request in flight', async () => {
    vi.useFakeTimers();
    try {
      const { click } = await open();
      await click('全选');
      host.remove.mockResolvedValue({ deleted: true });
      await click('删除 3 个'); await click('确认删除');
      await act(async () => root!.unmount()); root = undefined;
      await vi.advanceTimersByTimeAsync(5000);
      expect(host.remove).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it('closing and reopening during the pause does not revive the stopped batch', async () => {
    vi.useFakeTimers();
    try {
      const { button, click } = await open();
      await click('全选');
      host.remove.mockResolvedValue({ deleted: true });
      await click('删除 3 个'); await click('确认删除');
      expect(host.remove).toHaveBeenCalledOnce();
      await click('关闭浮层');
      await click('管理分享链接');
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(host.remove).toHaveBeenCalledOnce();
      expect(button(rows.b).getAttribute('aria-checked')).toBe('false');
    } finally { vi.useRealTimers(); }
  });
  it('opens a link only through the opener, without toggling its row', async () => {
    host.openUrl.mockResolvedValue(undefined);
    const { button, click } = await open();
    await click('打开 First 11月3日 10:00');
    expect(host.openUrl).toHaveBeenCalledExactlyOnceWith(links[0]!.url);
    expect(button(rows.a).getAttribute('aria-checked')).toBe('false');
  });
});
