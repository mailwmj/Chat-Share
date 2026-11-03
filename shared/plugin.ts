import { defineRpc, defineSettings } from '@getpaseo/plugin';
import { z } from 'zod';

export const DEFAULT_VIEWER_URL = 'https://chat-share.pages.dev';

export const preferences = defineSettings({
  id: 'sharing', scope: 'host', version: 2,
  schema: z.object({
    viewerUrl: z.string().trim().default('').refine(value => {
      if (!value) return true;
      try {
        const url = new URL(value);
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
      } catch { return false; }
    }, '请输入无查询参数和片段的 HTTP(S) 查看器地址'),
  }),
  // A version change makes the SDK persist the parsed document without obsolete fields.
  migrate: values => values,
});

const shareVersion = z.object({ epoch: z.string().min(1), maxSeq: z.number().int().nonnegative() });
const sharedSnapshot = z.object({ url: z.string().url(), version: shareVersion });
export type SharedSnapshot = z.infer<typeof sharedSnapshot>;

export const shareAgent = defineRpc({
  name: 'share-agent',
  input: z.object({ agentId: z.string().min(1) }),
  output: z.union([sharedSnapshot, z.object({ error: z.string() })]),
});

export const listShares = defineRpc({
  name: 'list-shares',
  input: z.object({}),
  output: z.union([z.object({ links: z.record(z.string(), sharedSnapshot) }), z.object({ error: z.string() })]),
});
