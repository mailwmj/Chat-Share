import type { PluginServerContext } from '@getpaseo/plugin/server';
import { preferences, shareAgent } from './shared/plugin';
import type { Refetch } from './shared/snapshot';
import { shareSession } from './server/share';

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  server.handle(shareAgent, async ({ agentId }, { paseo }) => {
    const current = await settings.read();
    if (current.status !== 'ready') throw new Error('插件设置无效。请打开插件设置并重新保存。');
    return shareSession(current.values, async () => {
      const agent = paseo.agents.ref(agentId);
      const data = (await agent.refresh())?.agent;
      if (!data || data.archivedAt) throw new Error('Unavailable agent');
      return {
        session: { id: data.id, title: data.title ?? '', provider: data.provider, ...(data.model ? { model: data.model } : {}),
          cwd: data.cwd, createdAt: data.createdAt, updatedAt: data.updatedAt, capturedAt: new Date().toISOString() },
        refetch: options => agent.timeline.refetch(options) as ReturnType<Refetch>,
      };
    });
  });
  return () => {};
}
