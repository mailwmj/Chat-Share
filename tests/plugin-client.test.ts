import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PluginButtonContentProps, PluginClientContext } from '@getpaseo/plugin/client';
import { registerHeaders } from '../client/header';
import { createSharePopover } from '../client/share-popover';
import { observeDirectory } from '../client/directory';

const host = vi.hoisted(() => ({ rpc: vi.fn(), list: vi.fn(), copy: vi.fn(), toast: { show: vi.fn(), error: vi.fn() } }));
vi.mock('@getpaseo/plugin/client', () => {
  const api = { agents: { list: host.list } };
  return { usePaseo: () => api, useRpc: () => host.rpc };
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
  const View = ({ children }: { children?: unknown }) => createElement('div', null, children as never);
  const finish = () => ({ start: (done?: () => void) => done?.(), stop: () => {} });
  return {
    View,
    Text: ({ children, numberOfLines }: { children: unknown; numberOfLines?: number }) => createElement('span', { 'data-lines': numberOfLines }, children as never),
    Pressable: ({ children, onPress, disabled, accessibilityLabel, accessibilityState }: { children: unknown; onPress: () => void; disabled?: boolean; accessibilityLabel: string; accessibilityState?: { selected?: boolean } }) =>
      createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel, 'aria-selected': accessibilityState?.selected }, children as never),
    ActivityIndicator: () => null,
    AccessibilityInfo: { isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove: () => {} }) },
    Animated: { View, Value: class { setValue() {} }, timing: finish },
    Easing: { bezier: () => (t: number) => t, out: (f: unknown) => f, back: () => (t: number) => t },
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
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren(); vi.clearAllMocks(); });

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

describe('share popover', () => {
  it.each(['typed failure', 'wrapped transport failure'])('shows only a short message for a %s', async kind => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const dir = directory(); host.list.mockResolvedValue(dir);
    const short = '请在服务器安装 GitHub CLI（gh），并运行 gh auth login 登录。';
    const wrapped = 'Request failed: 未配置查看器地址。请先在插件设置填写查看器 URL。 requestType=plugin.rpc.invoke.request code=handler_error';
    if (kind === 'typed failure') host.rpc.mockResolvedValueOnce({ error: short });
    else host.rpc.mockRejectedValueOnce(new Error(wrapped));
    const expected = kind === 'typed failure' ? short : '分享失败，请稍后重试。';
    const node = document.createElement('div'); document.body.append(node); root = createRoot(node);
    const Content = createSharePopover();
    await act(async () => root!.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Content,
      { workspaceId: 'current', theme: { colors: {} }, layout: { compact: false, platform: 'web' } } as PluginButtonContentProps))));
    await act(async () => dir.snapshot({ entries: [{ agent: { id: 'synthetic', title: 'Synthetic', provider: 'codex', workspaceId: 'current' } }] }));
    await act(async () => { node.querySelector('button')!.click(); await new Promise(done => setTimeout(done, 10)); });
    expect(host.toast.error).toHaveBeenCalledExactlyOnceWith(expected);
    expect(node.textContent).toContain(expected);
    expect(node.textContent).not.toContain('Request failed:');
    expect(node.textContent).not.toContain('requestType=');
    expect(node.textContent).not.toContain('code=handler_error');
    expect(host.copy).not.toHaveBeenCalled();
  });
  it('one click uploads, a second click during upload creates nothing, and clipboard failure retains a copyable link', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const dir = directory(); host.list.mockResolvedValue(dir);
    const pending = deferred<{ url: string }>(); host.rpc.mockReturnValue(pending.promise);
    host.copy.mockRejectedValue(new Error('clipboard denied'));
    const node = document.createElement('div'); document.body.append(node); root = createRoot(node);
    const Content = createSharePopover();
    const props = { workspaceId: 'current', theme: { colors: {} }, layout: { compact: false, platform: 'web' } } as PluginButtonContentProps;
    await act(async () => root!.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }) }, createElement(Content, props))));
    await act(async () => dir.snapshot({ entries: [
      { agent: { id: 'chosen', title: 'Synthetic agent', provider: 'codex', workspaceId: 'current', updatedAt: '2026-11-03T10:00:00Z' } },
      { agent: { id: 'elsewhere', title: 'Other workspace', provider: 'claude', workspaceId: 'other' } },
      { agent: { id: 'archived', title: 'Archived', provider: 'claude', workspaceId: 'current', archivedAt: 'yesterday' } },
    ] }));
    expect(node.textContent).toContain('Synthetic agent'); expect(node.textContent).toContain('codex');
    expect(node.textContent).not.toContain('Other workspace'); expect(node.textContent).not.toContain('Archived');
    const button = node.querySelector('button')!;
    await act(async () => { button.click(); button.click(); await new Promise(done => setTimeout(done, 10)); });
    expect(host.rpc).toHaveBeenCalledExactlyOnceWith({ agentId: 'chosen' });
    expect(node.textContent).toContain('正在分享');
    const url = `https://viewer.example/#synthetic/${'a'.repeat(32)}`;
    await act(async () => { pending.resolve({ url }); await new Promise(done => setTimeout(done, 10)); });
    expect(host.copy).toHaveBeenCalledExactlyOnceWith(url); expect(host.toast.error).toHaveBeenCalledWith('复制失败，请复制下方链接。');
    expect(node.textContent).toContain(url); expect(node.textContent).toContain('复制链接');
    host.copy.mockResolvedValue(undefined);
    await act(async () => (Array.from(node.querySelectorAll('button')).find(button => button.textContent === '复制链接')!).click());
    expect(host.toast.show).toHaveBeenCalledWith('链接已复制', { variant: 'success' });
    expect(host.rpc).toHaveBeenCalledOnce();
    await act(async () => root!.unmount()); root = undefined; expect(dir.release).toHaveBeenCalledOnce();
  });
  it('orders agents newest first in both the snapshot and live updates', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const dir = directory(); host.list.mockResolvedValue(dir);
    const node = document.createElement('div'); document.body.append(node); root = createRoot(node);
    const Content = createSharePopover();
    await act(async () => root!.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Content,
      { workspaceId: 'current', theme: { colors: {} }, layout: { compact: false, platform: 'web' } } as PluginButtonContentProps))));
    const older = { id: 'old', title: 'Older', provider: 'claude', workspaceId: 'current', updatedAt: '2026-11-03T08:00:00Z' };
    const newer = { id: 'new', title: 'Newer', provider: 'codex', workspaceId: 'current', updatedAt: '2026-11-03T09:00:00Z' };
    const titles = () => Array.from(node.querySelectorAll('button')).map(button => button.getAttribute('aria-label'));
    await act(async () => dir.snapshot({ entries: [{ agent: older }, { agent: newer }] }));
    expect(titles()).toEqual(['分享 Newer', '分享 Older']);
    await act(async () => dir.update({ type: 'agent_update', payload: { kind: 'upsert', agent: { ...older, updatedAt: '2026-11-03T10:00:00Z' } } }));
    expect(titles()).toEqual(['分享 Older', '分享 Newer']);
  });
  it('marks the shared session while sharing and after, enables copying only once a link exists, and expands the link only when copying fails', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const dir = directory(); host.list.mockResolvedValue(dir);
    const pending = deferred<{ url: string }>(); host.rpc.mockReturnValue(pending.promise);
    host.copy.mockResolvedValue(undefined);
    const node = document.createElement('div'); document.body.append(node); root = createRoot(node);
    const Content = createSharePopover();
    await act(async () => root!.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Content,
      { workspaceId: 'current', theme: { colors: {} }, layout: { compact: false, platform: 'web' } } as PluginButtonContentProps))));
    await act(async () => dir.snapshot({ entries: [
      { agent: { id: 'a', title: 'First', provider: 'claude', workspaceId: 'current', updatedAt: '2026-11-03T10:00:00Z' } },
      { agent: { id: 'b', title: 'Second', provider: 'codex', workspaceId: 'current', updatedAt: '2026-11-03T09:00:00Z' } },
    ] }));
    const row = (label: string) => node.querySelector(`button[aria-label="分享 ${label}"]`)!;
    const copyButton = () => Array.from(node.querySelectorAll('button')).find(button => button.textContent === '复制链接')!;
    expect(row('First').getAttribute('aria-selected')).toBe('false');
    await act(async () => { (row('Second') as HTMLButtonElement).click(); await new Promise(done => setTimeout(done, 10)); });
    expect(row('Second').getAttribute('aria-selected')).toBe('true');
    expect(row('First').getAttribute('aria-selected')).toBe('false');
    expect(copyButton().disabled).toBe(true);
    const url = `https://viewer.example/#synthetic/${'b'.repeat(32)}`;
    await act(async () => { pending.resolve({ url }); await new Promise(done => setTimeout(done, 10)); });
    expect(row('Second').getAttribute('aria-selected')).toBe('true');
    expect(copyButton().disabled).toBe(false);
    const linkText = () => Array.from(node.querySelectorAll('span')).find(span => span.textContent === url)!;
    expect(linkText().getAttribute('data-lines')).toBe('1');
    host.copy.mockRejectedValueOnce(new Error('denied'));
    await act(async () => { copyButton().click(); await new Promise(done => setTimeout(done, 10)); });
    expect(linkText().getAttribute('data-lines')).toBeNull();
    expect(host.rpc).toHaveBeenCalledOnce();
  });
});
