import type { PluginClientContext } from '@getpaseo/plugin/client';
import { registerHeaders } from './client/header';
import { setLocale } from './client/i18n';
import { createSharePopover, listAllAgents } from './client/share-popover';
import { listShares } from './shared/plugin';

export default function contribute(client: PluginClientContext) {
  setLocale(client.i18n.locale);
  const removeHeaders = registerHeaders(client, createSharePopover(() => client.rpc(listShares, {}), () => listAllAgents(client.paseo)));
  return removeHeaders;
}
