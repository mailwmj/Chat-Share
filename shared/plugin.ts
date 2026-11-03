import { defineRpc, defineSettings } from '@getpaseo/plugin';
import { z } from 'zod';

export const preferences = defineSettings({
  id: 'sharing', scope: 'host', version: 1,
  schema: z.object({
    viewerUrl: z.string().trim().default('').refine(value => {
      if (!value) return true;
      try {
        const url = new URL(value);
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
      } catch { return false; }
    }, '请输入无查询参数和片段的 HTTP(S) 查看器地址'),
    fallbackToken: z.string().trim().default(''),
  }),
});

export const shareAgent = defineRpc({
  name: 'share-agent',
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({ url: z.string().url() }),
});
