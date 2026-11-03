import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Image, ImageReference, Definition, RootContent } from 'mdast';
import {
  LOCAL_IMAGE_MARKER, MAX_SHARE_BYTES, ShareError, isObject,
  type Json, type SessionMetadata, type ShareDocument, type SnapshotMetadata, type TimelineEntry, type Truncation,
} from './format';

function externalImage(url: string): boolean {
  try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
}

/** Source positions preserve surrounding Markdown, including code fences and escaped syntax. */
export function replaceLocalImages(text: string): string {
  if (/^data:image\//i.test(text.trimStart())) return LOCAL_IMAGE_MARKER;
  if (!text.includes('![')) return text;
  const tree = fromMarkdown(text);
  const definitions = new Map<string, Definition>();
  const images: (Image | ImageReference)[] = [];
  const nodes: (RootContent | typeof tree)[] = [tree];
  while (nodes.length) {
    const node = nodes.pop()!;
    if (node.type === 'definition') definitions.set(node.identifier, node);
    if (node.type === 'image' || node.type === 'imageReference') images.push(node);
    if ('children' in node) nodes.push(...node.children as RootContent[]);
  }
  const ranges = new Map<number, { end: number; replacement: string }>();
  for (const image of images) {
    const definition = image.type === 'imageReference' ? definitions.get(image.identifier) : undefined;
    const url = image.type === 'image' ? image.url : definition?.url;
    if (url === undefined || externalImage(url)) continue;
    ranges.set(image.position!.start.offset!, { end: image.position!.end.offset!, replacement: LOCAL_IMAGE_MARKER });
    if (definition) ranges.set(definition.position!.start.offset!, { end: definition.position!.end.offset!, replacement: '' });
  }
  for (const [start, { end, replacement }] of [...ranges].sort((a, b) => b[0] - a[0])) {
    text = text.slice(0, start) + replacement + text.slice(end);
  }
  return text;
}

function localImagePayload(value: Record<string, unknown>): boolean {
  if (!['image', 'input_image', 'image_url'].includes(String(value.type))) return false;
  const source = isObject(value.source) ? value.source : {};
  const imageUrl = isObject(value.image_url) ? value.image_url.url : value.image_url;
  const inlineData = [value.data, source.data].some(data => typeof data === 'string' && data.length > 0 && !externalImage(data));
  return inlineData || [value.url, imageUrl, source.url].some(url => typeof url === 'string' && /^(?:data:|file:)/i.test(url));
}

function convertValue(value: Json): Json {
  if (typeof value === 'string') return /^data:image\/[^\s,]+,[^\s]*$/i.test(value.trim()) ? LOCAL_IMAGE_MARKER : value;
  if (Array.isArray(value)) return value.map(convertValue);
  if (isObject(value)) {
    if (localImagePayload(value)) return LOCAL_IMAGE_MARKER;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, convertValue(child as Json)]));
  }
  return value;
}

/** Pure conversion: preserve the complete timeline envelope, changing only local image content. */
export function toShare(session: SessionMetadata, snapshot: SnapshotMetadata, source: readonly TimelineEntry[]): ShareDocument {
  const truncations: Truncation[] = [];
  const entries = source.map((entry, i) => {
    const converted = convertValue(entry as unknown as Json) as unknown as TimelineEntry;
    // A future top-level image row still needs a valid, renderable item object.
    if (typeof converted.item === 'string') converted.item = { type: 'image_omitted', text: LOCAL_IMAGE_MARKER };
    if (['user_message', 'assistant_message', 'reasoning'].includes(entry.item.type) && typeof entry.item.text === 'string') {
      converted.item.text = replaceLocalImages(entry.item.text);
    }
    const detail = entry.item.detail;
    if (entry.item.type === 'tool_call' && isObject(detail)) {
      if (detail.type === 'plain_text' && typeof detail.text === 'string' && detail.text.endsWith('[Content truncated]')) {
        truncations.push({ entry: i, path: ['item', 'detail', 'text'], certainty: 'definite' });
      }
      if (detail.type === 'edit' && typeof detail.unifiedDiff === 'string' && detail.unifiedDiff.endsWith(']') && /\.\.\.\[truncated \d+ chars\]$/.test(detail.unifiedDiff)) {
        truncations.push({ entry: i, path: ['item', 'detail', 'unifiedDiff'], certainty: 'definite' });
      }
      if (['search', 'worktree_setup'].includes(String(detail.type)) && detail.truncated === true) {
        truncations.push({ entry: i, path: ['item', 'detail', 'truncated'], certainty: 'definite' });
      }
      if (detail.type === 'shell' && typeof detail.output === 'string' && detail.output.length === 65_536) {
        truncations.push({ entry: i, path: ['item', 'detail', 'output'], certainty: 'possible' });
      }
      const error = entry.item.error;
      if (detail.type === 'shell' && entry.item.status === 'failed' && isObject(error) && typeof error.content === 'string' && error.content.length === 65_536) {
        truncations.push({ entry: i, path: ['item', 'error', 'content'], certainty: 'possible' });
      }
    }
    return converted;
  });
  const result: ShareDocument = { version: 1, session: { ...session }, snapshot: { epoch: snapshot.epoch, window: { ...snapshot.window } }, entries, truncations };
  const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
  if (bytes > MAX_SHARE_BYTES) throw new ShareError('oversized', bytes);
  return result;
}
