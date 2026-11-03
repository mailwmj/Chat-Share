import { describe, expect, it } from 'vitest';
import { preferences } from '../shared/plugin';

describe('sharing settings', () => {
  it('keeps a single optional URL input, preserving an empty saved value', () => {
    expect(preferences.schema.parse({})).toEqual({ viewerUrl: '' });
    expect(preferences.schema.parse({ viewerUrl: '' })).toEqual({ viewerUrl: '' });
    expect(preferences.schema.parse({ viewerUrl: ' https://custom.example/view/ ' })).toEqual({ viewerUrl: 'https://custom.example/view/' });
    expect(preferences.schema.safeParse({ viewerUrl: 'ftp://invalid' }).success).toBe(false);
  });
  it('bumps the version so the SDK persists the removal of a legacy plaintext credential', async () => {
    const legacy = { viewerUrl: 'https://custom.example/', fallbackToken: 'synthetic-legacy-secret' };
    expect(preferences.version).toBe(2);
    const migrated = await preferences.migrate!(legacy, 1);
    expect(preferences.schema.parse(migrated)).toEqual({ viewerUrl: 'https://custom.example/' });
  });
});
