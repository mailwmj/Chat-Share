import { describe, it, expect } from 'vitest';
import { replaceLocalImages, toShare } from '../shared/convert';
import { parseShare, MAX_SHARE_BYTES, type TimelineEntry } from '../shared/format';
import { fenced, downloadMarkdown } from '../shared/download';
import { session, snapshot, entry, maliciousShare } from './fixtures';

function tool(detail: TimelineEntry['item']['detail'], extra = {}) {
  return entry({ type: 'tool_call', name: 'Synthetic', callId: 'synthetic', status: 'completed', error: null, detail, ...extra });
}

describe('lossless share conversion', () => {
  it('preserves original envelopes, arbitrary payloads, plugin and future item fields without mutation', () => {
    const entries = [tool({ type: 'unknown', input: { nested: [null, true, 4] }, output: { content: 'complete' } }, { agentMessage: { event: 'finished', sender: { id: 'child' }, text: 'return' } }),
      entry({ type: 'plugin', kind: 'example', data: { custom: 'retained' } }), entry({ type: 'notification', level: 'info', message: 'retained' }),
      entry({ type: 'future_kind', data: { arbitrary: [1, 'two'] } })];
    const original = JSON.stringify(entries);
    const share = toShare(session, snapshot, entries);
    expect(share.entries).toEqual(entries);
    expect(JSON.stringify(entries)).toBe(original);
    expect(share.session).toEqual(session);
    expect(parseShare(JSON.stringify(share))).toEqual(share);
    expect(share.entries[0]).not.toBe(entries[0]);
  });
  it('preserves prototype-looking JSON keys as data', () => {
    const data = JSON.parse('{"__proto__":{"polluted":true},"constructor":"kept"}');
    const share = toShare(session, snapshot, [entry({ type: 'future', data })]);
    expect(JSON.stringify(share)).toContain('"__proto__"');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('reports rather than silently clips exports over the byte limit, including non-ASCII', () => {
    expect(() => toShare(session, snapshot, [entry({ type: 'assistant_message', text: '汉'.repeat(3_333_334) })])).toThrow('oversized');
    expect(() => parseShare(' '.repeat(MAX_SHARE_BYTES + 1))).toThrow('oversized');
  });
  it('rejects incompatible or malformed external data while accepting new types', () => {
    for (const value of ['null', '{}', '{', JSON.stringify({ ...maliciousShare(), version: 2 }), JSON.stringify({ ...maliciousShare(), entries: [{ item: null }] })]) {
      expect(() => parseShare(value)).toThrow('invalid');
    }
    expect(() => parseShare(JSON.stringify(toShare(session, snapshot, [entry({ type: 'future' })])))).not.toThrow();
  });
  it('rejects excessive nesting with an explicit invalid state', () => {
    let data: object = {};
    for (let i = 0; i < 110; i++) data = { nested: data };
    const doc = { ...maliciousShare(), entries: [{ item: { type: 'future', data } }] };
    expect(() => parseShare(JSON.stringify(doc))).toThrow('invalid');
  });
});

describe('local image replacement', () => {
  it('replaces file/data/relative Markdown images, including escaped parentheses and references', () => {
    const source = 'Before ![a](file:///shot\\(1\\).png) and ![b](data:image/png;base64,AAAA)\n![c][local]\n\n[local]: ./local.png\nAfter';
    const result = replaceLocalImages(source);
    expect(result.match(/\[local image omitted\]/g)).toHaveLength(3);
    expect(result).not.toMatch(/file:|data:image|local\.png/);
    expect(result).toContain('Before'); expect(result).toContain('After');
  });
  it('keeps HTTP images verbatim, and does not rewrite code samples or non-image links', () => {
    const source = '![remote](https://example.com/a.png)\n![remote2](http://example.com/b.png)\n`![code](file:///example.png)`\n\n```md\n![code](file:///example.png)\n```\n[link](file:///file.txt)';
    expect(replaceLocalImages(source)).toBe(source);
  });
  it('replaces typed image blocks even inside unknown payloads, retaining adjacent text', () => {
    const share = toShare(session, snapshot, [tool({ type: 'unknown', input: { blocks: [{ type: 'image', data: 'synthetic-base64', mimeType: 'image/png' }, { type: 'text', text: 'retained' }] }, output: { deep: { type: 'input_image', image_url: 'data:image/png;base64,AAAA' } } })]);
    const text = JSON.stringify(share);
    expect(text).not.toContain('synthetic-base64'); expect(text).not.toContain('data:image');
    expect(text).toContain('retained'); expect(text.match(/local image omitted/g)).toHaveLength(2);
  });
});

describe('evidence-based truncation', () => {
  it('marks only explicit signals, never generic prose mentioning truncated', () => {
    const share = toShare(session, snapshot, [tool({ type: 'plain_text', text: '[Content truncated]' }), tool({ type: 'edit', unifiedDiff: 'diff\n...[truncated 42 chars]' }), tool({ type: 'search', query: 'x', truncated: true }), tool({ type: 'plain_text', text: 'The word truncated is part of this explanation.' })]);
    expect(share.truncations.map(mark => [mark.entry, mark.certainty])).toEqual([[0, 'definite'], [1, 'definite'], [2, 'definite']]);
  });
  it('uses UTF-16 units and limits possible truncation to shell output or failed shell error', () => {
    const cap = '😀'.repeat(32_768);
    const share = toShare(session, snapshot, [tool({ type: 'shell', command: 'x', output: cap }),
      tool({ type: 'shell', command: 'x', output: cap.slice(0, -1) }), tool({ type: 'read', content: cap }),
      tool({ type: 'shell', command: 'x' }, { status: 'failed', error: { content: cap } }),
      tool({ type: 'shell', command: 'x' }, { status: 'completed', error: { content: cap } })]);
    expect(share.truncations.map(mark => [mark.entry, mark.certainty])).toEqual([[0, 'possible'], [3, 'possible']]);
    expect(share.entries[0]!.item.detail).toEqual({ type: 'shell', command: 'x', output: cap });
  });
  it('does not weaken explicit evidence into a second possible-truncation label', () => {
    const text = 'x'.repeat(65_536 - '[Content truncated]'.length) + '[Content truncated]';
    const share = toShare(session, snapshot, [tool({ type: 'plain_text', text })]);
    expect(share.truncations.map(mark => mark.certainty)).toEqual(['definite']);
  });
});

describe('complete, fence-safe Markdown download', () => {
  it('contains every input, output, return message, and future field', () => {
    const share = maliciousShare(), markdown = downloadMarkdown(share, 'en');
    expect(markdown).toContain('Read the structure');
    expect(markdown).toContain('return send();');
    expect(markdown).toContain('npm test -- request');
    expect(markdown).toContain('PASS request.test.ts\n');
    expect(markdown).toContain(JSON.stringify(share.entries.find(record => record.item.type === 'future_item<script>')!.item, null, 2));
    expect(markdown).toContain('Synthetic return result.');
    expect(markdown).toContain('globalThis.__xssExecuted');
  });
  it('uses a fence longer than every run in the payload, including giant odd strings', () => {
    for (const text of ['```\n````\nattack', '`'.repeat(5000), 'x`x'.repeat(100_000)]) {
      const output = fenced(text, 'json'), opening = output.split('\n')[0]!.replace('json', '');
      expect(opening.length).toBeGreaterThan(Math.max(0, ...((text.match(/`+/g) ?? []).slice(0, 1000).map(s => s.length))));
      expect(output).toContain(text);
      expect(output.endsWith(opening)).toBe(true);
    }
  });
});
