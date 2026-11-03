export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface TimelineEntry {
  item: JsonObject & { type: string };
  [key: string]: Json;
}

export interface SessionMetadata {
  id: string;
  title: string;
  provider: string;
  model?: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  capturedAt: string;
}

export interface TimelineWindow { minSeq: number; maxSeq: number; nextSeq: number }
export interface SnapshotMetadata { epoch: string; window: TimelineWindow }
export interface Truncation {
  entry: number;
  path: string[];
  certainty: 'definite' | 'possible';
}

export interface ShareDocument {
  version: 1;
  session: SessionMetadata;
  snapshot: SnapshotMetadata;
  entries: TimelineEntry[];
  truncations: Truncation[];
}

export const MAX_SHARE_BYTES = 10_000_000;
export const SHARE_FILENAME = 'chat-share.json';
export const LOCAL_IMAGE_MARKER = '[local image omitted]';

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ShareError extends Error {
  constructor(public readonly code: 'invalid' | 'oversized' | 'not-found' | 'load' | 'snapshot', public readonly bytes?: number) {
    super(code);
    this.name = 'ShareError';
  }
}

/** External JSON boundary: reject unsupported versions and unsafe resource depth, retain new fields. */
export function parseShare(text: string): ShareDocument {
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > MAX_SHARE_BYTES) throw new ShareError('oversized', bytes);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ShareError('invalid'); }
  if (!isObject(value) || value.version !== 1 || !isObject(value.session) || !isObject(value.snapshot)
    || !Array.isArray(value.entries) || !Array.isArray(value.truncations)) throw new ShareError('invalid');
  const session = value.session;
  for (const key of ['id', 'title', 'provider', 'cwd', 'createdAt', 'updatedAt', 'capturedAt']) {
    if (typeof session[key] !== 'string') throw new ShareError('invalid');
  }
  if (session.model !== undefined && typeof session.model !== 'string') throw new ShareError('invalid');
  const snapshot = value.snapshot;
  if (typeof snapshot.epoch !== 'string' || !isObject(snapshot.window)) throw new ShareError('invalid');
  for (const key of ['minSeq', 'maxSeq', 'nextSeq']) {
    if (!Number.isSafeInteger(snapshot.window[key]) || (snapshot.window[key] as number) < 0) throw new ShareError('invalid');
  }
  for (const entry of value.entries) {
    if (!isObject(entry) || !isObject(entry.item) || typeof entry.item.type !== 'string') throw new ShareError('invalid');
  }
  for (const annotation of value.truncations) {
    if (!isObject(annotation) || !Number.isInteger(annotation.entry) || (annotation.entry as number) < 0
      || (annotation.entry as number) >= value.entries.length || !Array.isArray(annotation.path)
      || !annotation.path.every(p => typeof p === 'string')
      || !['definite', 'possible'].includes(annotation.certainty as string)) throw new ShareError('invalid');
  }
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (stack.length) {
    const next = stack.pop()!;
    if (next.depth > 100) throw new ShareError('invalid');
    if (next.value && typeof next.value === 'object') {
      for (const child of Object.values(next.value)) stack.push({ value: child, depth: next.depth + 1 });
    }
  }
  return value as unknown as ShareDocument;
}
