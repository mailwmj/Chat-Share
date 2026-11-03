import { describe, it, expect, vi } from 'vitest';
import { readSnapshot, type TimelinePage } from '../shared/snapshot';
import { entry, snapshot } from './fixtures';

function page(patch: Partial<TimelinePage> = {}): TimelinePage {
  return { ...snapshot, entries: [entry({ type: 'user_message', text: 'synthetic' })], reset: false, gap: false, staleCursor: false,
    hasOlder: false, hasNewer: false, startCursor: { epoch: snapshot.epoch, seq: 1 }, error: null, ...patch };
}

describe('snapshot consistency', () => {
  it('uses one unlimited response when the daemon supplies a complete window', async () => {
    const refetch = vi.fn().mockResolvedValue(page());
    const result = await readSnapshot(refetch);
    expect(refetch).toHaveBeenCalledExactlyOnceWith({ direction: 'tail', limit: 0, projection: 'projected' });
    expect(result.entries).toHaveLength(1);
  });
  it.each(['reset', 'gap', 'staleCursor', 'hasNewer'] as const)('retries %s rather than exporting a torn response', async flag => {
    const refetch = vi.fn().mockResolvedValueOnce(page({ [flag]: true })).mockResolvedValue(page());
    await expect(readSnapshot(refetch)).resolves.toHaveProperty('snapshot.epoch', snapshot.epoch);
    expect(refetch).toHaveBeenCalledTimes(2);
  });
  it('discards mixed epochs during fallback pagination and starts again', async () => {
    const refetch = vi.fn().mockResolvedValueOnce(page({ hasOlder: true, startCursor: { epoch: snapshot.epoch, seq: 8 }, entries: [entry({ type: 'assistant_message', text: 'old' }, 8)] }))
      .mockResolvedValueOnce(page({ epoch: 'changed' })).mockResolvedValueOnce(page({ epoch: 'fresh', entries: [entry({ type: 'user_message', text: 'fresh' })] }));
    const result = await readSnapshot(refetch);
    expect(result.snapshot.epoch).toBe('fresh');
    expect(result.entries.map(e => e.item.text)).toEqual(['fresh']);
  });
  it('falls back to ordered pagination, with no duplicate ranges or dropped unknown rows', async () => {
    const newer = entry({ type: 'future', payload: true }, 8), older = entry({ type: 'notification', message: 'old' }, 1);
    const refetch = vi.fn().mockResolvedValueOnce(page({ entries: [newer], hasOlder: true, startCursor: { epoch: snapshot.epoch, seq: 8 } }))
      .mockResolvedValueOnce(page({ entries: [older] }));
    expect((await readSnapshot(refetch)).entries).toEqual([older, newer]);
    expect(refetch.mock.calls[1]![0]).toEqual({ direction: 'before', limit: 200, cursor: { epoch: snapshot.epoch, seq: 8 }, projection: 'projected' });
  });
  it('stops after three inconsistent attempts and never returns partial data', async () => {
    const refetch = vi.fn().mockResolvedValue(page({ gap: true }));
    await expect(readSnapshot(refetch)).rejects.toThrow('snapshot'); expect(refetch).toHaveBeenCalledTimes(3);
  });
  it('surfaces service errors without retrying them as consistency failures', async () => {
    const refetch = vi.fn().mockResolvedValue(page({ error: 'synthetic error' }));
    await expect(readSnapshot(refetch)).rejects.toThrow('load'); expect(refetch).toHaveBeenCalledTimes(1);
  });
});
