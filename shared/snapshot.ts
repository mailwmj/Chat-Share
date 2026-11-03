import { ShareError, type SnapshotMetadata, type TimelineEntry } from './format';

export interface TimelinePage extends SnapshotMetadata {
  entries: TimelineEntry[];
  reset: boolean;
  gap: boolean;
  staleCursor: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
  startCursor: { epoch: string; seq: number } | null;
  error: string | null;
}
export type Refetch = (options: {
  direction: 'tail' | 'before'; limit: number; projection: 'projected'; cursor?: { epoch: string; seq: number };
}) => Promise<TimelinePage>;

class SnapshotChanged extends Error {}
function check(page: TimelinePage, epoch = page.epoch): void {
  if (page.error) throw new ShareError('load');
  if (!page.epoch || page.epoch !== epoch || page.reset || page.gap || page.staleCursor) throw new SnapshotChanged();
}

/** Prefer one daemon response. Pagination is a fallback, never a silently partial export. */
export async function readSnapshot(refetch: Refetch): Promise<{ snapshot: SnapshotMetadata; entries: TimelineEntry[] }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let page = await refetch({ direction: 'tail', limit: 0, projection: 'projected' });
      check(page);
      if (page.hasNewer) throw new SnapshotChanged();
      const snapshot = { epoch: page.epoch, window: { ...page.window } };
      let entries = [...page.entries];
      while (page.hasOlder) {
        const cursor = page.startCursor;
        if (!cursor || cursor.epoch !== snapshot.epoch) throw new SnapshotChanged();
        page = await refetch({ direction: 'before', cursor, limit: 200, projection: 'projected' });
        check(page, snapshot.epoch);
        if (page.hasOlder && (!page.startCursor || page.startCursor.seq >= cursor.seq)) throw new SnapshotChanged();
        entries.push(...page.entries);
      }
      if (entries.some(entry => typeof entry.seqEnd === 'number' && entry.seqEnd > snapshot.window.maxSeq)) throw new SnapshotChanged();
      const byRange = new Map<string, TimelineEntry>();
      for (const [i, entry] of entries.entries()) {
        const key = typeof entry.seqStart === 'number' && typeof entry.seqEnd === 'number' ? `${entry.seqStart}:${entry.seqEnd}` : `unsequenced:${i}`;
        byRange.set(key, entry);
      }
      entries = [...byRange.values()].sort((a, b) => Number(a.seqStart ?? 0) - Number(b.seqStart ?? 0));
      return { snapshot, entries };
    } catch (error) {
      if (!(error instanceof SnapshotChanged)) throw error;
    }
  }
  throw new ShareError('snapshot');
}
