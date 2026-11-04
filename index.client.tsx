import type { PluginClientContext } from '@getpaseo/plugin/client';
import { registerHeaders } from './client/header';
import { createSharePopover, listAllAgents } from './client/share-popover';
import { listShares } from './shared/plugin';

export default function contribute(client: PluginClientContext) {
  const removeHeaders = registerHeaders(client, createSharePopover(() => client.rpc(listShares, {}), () => listAllAgents(client.paseo)));
  return removeHeaders;
}
