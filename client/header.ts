import { t } from './i18n';
import type { PluginClientContext, PluginButtonContentProps, PluginButtonRegistration } from '@getpaseo/plugin/client';
import type { ComponentType } from 'react';
import { observeDirectory } from './directory';

export function registerHeaders(client: PluginClientContext, Content: ComponentType<PluginButtonContentProps>): () => void {
  const lifetime = new AbortController();
  const buttons = new Map<string, PluginButtonRegistration>();
  const remove = (id: string) => { buttons.get(id)?.remove(); buttons.delete(id); };
  const add = (id: string) => {
    if (lifetime.signal.aborted || buttons.has(id)) return;
    buttons.set(id, client.addHeaderButton({ id: 'share', workspaceId: id,
      button: { title: t('分享会话', 'Share conversation'), icon: 'Share', behavior: { kind: 'popover', Content } } }));
  };
  const stop = observeDirectory(
    (cursor, subscribe) => client.paseo.workspaces.list({ includeBackground: true, page: { limit: 200, cursor }, ...(subscribe ? { subscribe: {} } : {}) }),
    {
        snapshot: entries => {
          const ids = new Set(entries.map(workspace => workspace.id));
          for (const id of buttons.keys()) if (!ids.has(id)) remove(id);
          for (const id of ids) add(id);
        },
        update: message => {
          if (message.type !== 'workspace_update') return;
          const update = message.payload;
          if (update.kind === 'upsert') add(update.workspace.id);
          else remove(update.id);
        },
        error: () => { if (!lifetime.signal.aborted) console.error('Chat-Share：工作区订阅读取失败'); },
    });
  return () => { lifetime.abort(); stop(); for (const id of buttons.keys()) remove(id); };
}
