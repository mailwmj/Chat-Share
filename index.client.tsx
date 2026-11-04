import { t } from './client/i18n';
import type { PluginClientContext } from '@getpaseo/plugin/client';
import { registerHeaders } from './client/header';
import { createSharePopover, listAllAgents } from './client/share-popover';
import { ShareSettings } from './client/settings';
import { listShares } from './shared/plugin';

export default function contribute(client: PluginClientContext) {
  const removeSettings = client.addSettingsScreen({ id: 'sharing', title: t('会话分享', 'Conversation sharing'), icon: 'Share', Component: ShareSettings });
  const removeHeaders = registerHeaders(client, createSharePopover(() => client.rpc(listShares, {}), () => listAllAgents(client.paseo)));
  return () => { removeHeaders(); removeSettings(); };
}
