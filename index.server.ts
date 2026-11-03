import type { PluginServerContext } from '@getpaseo/plugin/server';
import { preferences, shareAgent } from './shared/plugin';
import type { Refetch } from './shared/snapshot';
import { ShareFailure, shareSession } from './server/share';

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  // Trigger persisted schema migration even if no settings page or sharing RPC is opened.
  void settings.read().catch(() => console.error('读取会话分享设置失败。'));
  server.handle(shareAgent, async ({ agentId }, { paseo }) => {
    try {
      const current = await settings.read();
      if (current.status !== 'ready') throw new ShareFailure('插件设置无效。请打开插件设置并重新保存。');
      return await shareSession(current.values, async () => {
        const agent = paseo.agents.ref(agentId);
        const data = (await agent.refresh())?.agent;
        if (!data || data.archivedAt) throw new Error('Unavailable agent');
        return {
          session: { id: data.id, title: data.title ?? '', provider: data.provider, ...(data.model ? { model: data.model } : {}),
            cwd: data.cwd, createdAt: data.createdAt, updatedAt: data.updatedAt, capturedAt: new Date().toISOString() },
          refetch: options => agent.timeline.refetch(options) as ReturnType<Refetch>,
        };
      });
    } catch (error) {
      return { error: error instanceof ShareFailure ? error.message : '分享失败，请稍后重试。' };
    }
  });
  return () => {};
}
