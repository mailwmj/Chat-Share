import type { PluginClientContext } from '@getpaseo/plugin/client';
import { registerHeaders } from './client/header';
import { createSharePopover } from './client/share-popover';
import { ShareSettings } from './client/settings';

export default function contribute(client: PluginClientContext) {
  const removeSettings = client.addSettingsScreen({ id: 'sharing', title: '会话分享', icon: 'Share', Component: ShareSettings });
  const removeHeaders = registerHeaders(client, createSharePopover());
  return () => { removeHeaders(); removeSettings(); };
}
