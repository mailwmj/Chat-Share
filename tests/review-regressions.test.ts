import { describe, it, expect } from 'vitest';
import MarkdownIt from 'markdown-it';
import { toShare } from '../shared/convert';
import { downloadMarkdown } from '../shared/download';
import type { JsonObject, TimelineEntry } from '../shared/format';
import { renderTimeline } from '../viewer/src/render';
import { messages } from '../viewer/src/i18n';
import { entry, session, snapshot } from './fixtures';

const md = new MarkdownIt({ html: false });
const tool = (detail: JsonObject, extra: JsonObject = {}) => entry({ type: 'tool_call', name: 'Synthetic', callId: 'synthetic', status: 'completed', error: null, detail, ...extra });
const share = (entries: TimelineEntry[]) => toShare(session, snapshot, entries);
const fences = (text: string) => md.parse(text, {}).filter(token => token.type === 'fence');
const open = (row: HTMLDetailsElement) => { row.open = true; row.dispatchEvent(new Event('toggle')); };

describe('review: conversion boundaries', () => {
  it.each(['user_message', 'assistant_message', 'reasoning'])('replaces Markdown images only in %s prose, preserving tool source verbatim', type => {
    const source = '# App\n![logo](docs/logo.png)\n';
    const tools = [tool({ type: 'read', content: source }), tool({ type: 'write', content: source }),
      tool({ type: 'edit', oldString: source, newString: source, unifiedDiff: '+![logo](./logo.png)' }),
      tool({ type: 'shell', command: source, output: source }), tool({ type: 'unknown', input: source, output: source })];
    const before = JSON.stringify(tools);
    const converted = share([entry({ type, text: source }), ...tools]);
    expect(converted.entries.slice(1)).toEqual(tools);
    expect(converted.entries[0]!.item.text).toBe('# App\n[local image omitted]\n');
    expect(JSON.stringify(tools)).toBe(before);
  });
  it('keeps remote and payload-free image objects while removing actual local image payloads', () => {
    const retained: JsonObject[] = [
      { type: 'image', caption: 'an image-shaped application value' },
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
      { type: 'input_image', image_url: 'http://example.com/b.png' },
      { type: 'image', source: { type: 'url', url: 'https://example.com/c.png' } },
    ];
    const removed: JsonObject[] = [
      { type: 'image', data: 'synthetic-base64', mimeType: 'image/png' },
      { type: 'image_url', image_url: { url: 'file:///synthetic/image.png' } },
      { type: 'image', source: { type: 'base64', data: 'synthetic-base64', media_type: 'image/png' } },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    ];
    const result = share([tool({ type: 'unknown', input: { retained, removed, bytes: 'data:image/png;base64,AAAA' } })]);
    const detail = result.entries[0]!.item.detail as JsonObject;
    expect((detail.input as JsonObject).retained).toEqual(retained);
    expect((detail.input as JsonObject).removed).toEqual(removed.map(() => '[local image omitted]'));
    expect((detail.input as JsonObject).bytes).toBe('[local image omitted]');
  });
  it.each(['user_message', 'assistant_message', 'reasoning'])('never treats a quoted truncation marker in %s as provenance', type => {
    const result = share([entry({ type, text: 'This discusses [Content truncated] and ...[truncated 42 chars]' })]);
    expect(result.truncations).toEqual([]);
  });
  it('accepts plain_text suffix markers only, not markers in its middle or other fields', () => {
    const result = share([tool({ type: 'plain_text', text: 'quoted [Content truncated] in the middle' }),
      tool({ type: 'plain_text', label: '[Content truncated]', text: 'complete' }),
      tool({ type: 'plain_text', text: 'output\n\n[Content truncated]' })]);
    expect(result.truncations.map(mark => [mark.entry, mark.path])).toEqual([[2, ['item', 'detail', 'text']]]);
  });
  it('accepts diff suffix markers only on edit.unifiedDiff, never file contents or quoted diff markers', () => {
    const result = share([tool({ type: 'edit', oldString: '...[truncated 1 chars]', newString: '...[truncated 2 chars]' }),
      tool({ type: 'edit', unifiedDiff: '...[truncated 3 chars]\nmore diff' }),
      tool({ type: 'read', content: '...[truncated 4 chars]' }),
      tool({ type: 'edit', unifiedDiff: 'patch\n...[truncated 5 chars]' })]);
    expect(result.truncations.map(mark => [mark.entry, mark.path])).toEqual([[3, ['item', 'detail', 'unifiedDiff']]]);
  });
  it('trusts truncated flags only directly on search/worktree_setup detail', () => {
    const result = share([tool({ type: 'unknown', input: { truncated: true }, output: { truncated: true } }),
      tool({ type: 'search', query: 'x', nested: { truncated: true } }),
      tool({ type: 'search', query: 'x', truncated: true }), tool({ type: 'worktree_setup', log: '', truncated: true })]);
    expect(result.truncations.map(mark => [mark.entry, mark.path])).toEqual([[2, ['item', 'detail', 'truncated']], [3, ['item', 'detail', 'truncated']]]);
  });
  it('marks capped shell text as possible even if its content quotes a different tool’s marker', () => {
    const text = 'x'.repeat(65_536 - '[Content truncated]'.length) + '[Content truncated]';
    const result = share([tool({ type: 'shell', command: 'synthetic', output: text }, { status: 'failed', error: { content: text } })]);
    expect(result.truncations.map(mark => mark.certainty)).toEqual(['possible', 'possible']);
  });
});

describe('review: readable and unambiguous download', () => {
  it('uses an escaped single-line title heading and compact metadata without snapshot envelope noise', () => {
    const title = 'Build [links](https://example.com)\n## injected *heading* <script>';
    const result = downloadMarkdown(toShare({ ...session, title }, snapshot, [entry({ type: 'user_message', text: 'hello' })]), 'en');
    const headings = md.parse(result, {}).filter(token => token.type === 'heading_open');
    expect(headings[0]!.tag).toBe('h1'); expect(result.startsWith('# ')).toBe(true);
    const first = result.split('\n')[0]!;
    expect(first).toContain('\\[links\\]'); expect(first).toContain('\\*heading\\*'); expect(first).toContain('\\<script');
    expect(result).not.toMatch(/seqStart|seqEnd|sourceSeqRanges|synthetic-epoch/);
    expect(result).toContain(session.provider); expect(result).toContain(session.cwd);
  });
  it.each(['user_message', 'assistant_message', 'reasoning'])('includes %s text exactly once', type => {
    const text = `UNIQUE_${type}_CONTENT`;
    const result = downloadMarkdown(share([entry({ type, text })]), 'en');
    expect(result.split(text).length - 1).toBe(1);
  });
  it('keeps multiline shell output as real lines, with the same readable summary as the viewer', () => {
    const output = '1\n2\n3\n';
    const result = downloadMarkdown(share([tool({ type: 'shell', command: 'npm test', output }, { name: 'shell' })]), 'en');
    expect(fences(result).some(token => token.content === output)).toBe(true);
    expect(result).toContain('## 1 · Bash: npm test');
    expect(result).not.toContain('"output": "1\\n2\\n3\\n"');
  });
  it('keeps fences and forged headings inside the single output block', () => {
    const output = 'before\n```\n## forged\n````\nafter\n';
    const result = downloadMarkdown(share([tool({ type: 'shell', command: 'synthetic', output })]), 'en');
    expect(fences(result).some(token => token.content === output)).toBe(true);
    const headings = md.parse(result, {}).filter(token => token.type === 'inline' && token.map && token.level === 1);
    expect(headings.some(token => token.content === 'forged')).toBe(false);
  });
  it('cannot mistake a message’s fake tool heading for a structural section', () => {
    const text = 'Before\n## 5 · tool_call\nAfter';
    const result = downloadMarkdown(share([entry({ type: 'user_message', text }), tool({ type: 'shell', command: 'echo safe', output: 'safe\n' })]), 'en');
    const tokens = md.parse(result, {});
    expect(tokens.filter(token => token.type === 'heading_open' && token.tag === 'h2')).toHaveLength(2);
    expect(result.split('## 5 · tool_call').length - 1).toBe(1);
    expect(fences(result).some(token => token.content === text + '\n')).toBe(true);
  });
  const cases: { kind: string; detail: JsonObject; input: string; output: string }[] = [
    { kind: 'shell', detail: { type: 'shell', command: 'synthetic-command', output: 'shell first\nshell second\n' }, input: 'synthetic-command', output: 'shell first\nshell second\n' },
    { kind: 'read', detail: { type: 'read', filePath: '/synthetic/read.md', content: '# App\n![logo](docs/logo.png)\n' }, input: '/synthetic/read.md', output: '# App\n![logo](docs/logo.png)\n' },
    { kind: 'write', detail: { type: 'write', filePath: '/synthetic/write.md', content: 'write first\nwrite second\n' }, input: '/synthetic/write.md', output: 'write first\nwrite second\n' },
    { kind: 'edit', detail: { type: 'edit', filePath: '/synthetic/edit.md', unifiedDiff: '--- before\n+++ after\n@@ -1 +1 @@\n-old\n+![logo](./logo.png)\n' }, input: '/synthetic/edit.md', output: '--- before\n+++ after\n@@ -1 +1 @@\n-old\n+![logo](./logo.png)\n' },
    { kind: 'search', detail: { type: 'search', query: 'synthetic-query', content: 'match first\nmatch second\n' }, input: 'synthetic-query', output: 'match first\nmatch second\n' },
    { kind: 'fetch', detail: { type: 'fetch', url: 'https://example.com/synthetic', prompt: 'inspect', result: 'fetch first\nfetch second\n' }, input: 'https://example.com/synthetic', output: 'fetch first\nfetch second\n' },
    { kind: 'worktree_setup', detail: { type: 'worktree_setup', worktreePath: '/synthetic/worktree', branchName: 'synthetic-branch', log: 'setup first\nsetup second\n', commands: [{ index: 0, command: 'git status', cwd: '/synthetic/worktree', log: 'command first\ncommand second\n', status: 'completed', exitCode: 0 }] }, input: '/synthetic/worktree', output: 'setup first\nsetup second\n' },
    { kind: 'sub_agent', detail: { type: 'sub_agent', description: 'synthetic-task', log: 'return first\nreturn second\n' }, input: 'synthetic-task', output: 'return first\nreturn second\n' },
    { kind: 'plain_text', detail: { type: 'plain_text', label: 'synthetic-label', text: 'plain first\nplain second\n' }, input: 'synthetic-label', output: 'plain first\nplain second\n' },
    { kind: 'plan', detail: { type: 'plan', text: 'plan first\nplan second\n' }, input: 'Synthetic', output: 'plan first\nplan second\n' },
  ];
  it.each(cases)('exports $kind input and multiline output without JSON string escaping', ({ kind, detail, input, output }) => {
    const result = downloadMarkdown(share([tool(detail)]), 'en');
    expect(result).toContain(input);
    const outputBlock = fences(result).find(token => token.content === output);
    expect(outputBlock).toBeDefined();
    if (kind === 'edit') expect(outputBlock!.info).toBe('diff');
  });
  it.each(['unknown', 'plugin', 'notification', 'future_kind'])('exports %s content as item JSON exactly once, without the envelope', type => {
    const item: TimelineEntry['item'] = type === 'unknown'
      ? { type: 'tool_call', name: 'Custom', detail: { type: 'unknown', input: { all: ['INPUT_SENTINEL'] }, output: { all: ['OUTPUT_SENTINEL'] } }, agentMessage: { text: 'RETURN_SENTINEL' } }
      : { type, message: 'CONTENT_SENTINEL', data: { nested: ['NESTED_SENTINEL'] } };
    const result = downloadMarkdown(share([entry(item)]), 'en');
    const blocks = fences(result).filter(token => token.info === 'json').map(token => JSON.parse(token.content));
    expect(blocks).toContainEqual(item);
    expect(result.split(JSON.stringify(item, null, 2)).length - 1).toBe(1);
    expect(result).not.toContain('seqStart');
  });
  it('includes real multiline errors and worktree command logs, rather than JSON-escaped copies', () => {
    const result = downloadMarkdown(share([tool({ type: 'shell', command: 'fails', output: 'partial\nresult\n' }, { status: 'failed', error: { content: 'error first\nerror second\n' } }),
      tool({ type: 'worktree_setup', worktreePath: '/synthetic/tree', branchName: 'b', log: 'setup\n', commands: [{ command: 'prepare', cwd: '/synthetic/tree', log: 'command first\ncommand second\n', status: 'failed', exitCode: 1 }] })]), 'en');
    const content = fences(result).map(token => token.content);
    expect(content).toContain('error first\nerror second\n');
    expect(content).toContain('command first\ncommand second\n');
  });
});

describe('review: viewer polish', () => {
  it('merges only adjacent reasoning at render time, preserving text order and share data', () => {
    const data = share([entry({ type: 'reasoning', text: 'FIRST' }), entry({ type: 'reasoning', text: 'SECOND' }),
      tool({ type: 'shell', command: 'one', output: '' }), tool({ type: 'shell', command: 'two', output: '' }), entry({ type: 'reasoning', text: 'THIRD' })]);
    const before = JSON.stringify(data), view = renderTimeline(data, messages.en);
    const rows = view.querySelectorAll<HTMLDetailsElement>('.timeline-row[data-type="reasoning"]');
    expect(rows).toHaveLength(2); expect(view.querySelectorAll('[data-type="tool_call"]')).toHaveLength(2);
    open(rows[0]!);
    expect([...rows[0]!.querySelectorAll('.markdown')].map(node => node.textContent?.trim())).toEqual(['FIRST', 'SECOND']);
    expect(JSON.stringify(data)).toBe(before);
  });
  it('shows an edit path and diff without a duplicated Input JSON block, retaining incomplete edits', () => {
    const view = renderTimeline(share([tool({ type: 'edit', filePath: '/synthetic/edit.ts', oldString: 'old\n', newString: 'new\n' }),
      tool({ type: 'edit', filePath: '/synthetic/incomplete.ts', newString: 'INCOMPLETE_SOURCE' })]), messages.en);
    const stepRows = view.querySelectorAll<HTMLDetailsElement>('.timeline-row.step-row'); open(stepRows[0]!); open(stepRows[1]!);
    expect(stepRows[0]!.querySelector('.diff')).not.toBeNull();
    expect(stepRows[0]!.querySelector('.disclosure-body')!.textContent).toContain('/synthetic/edit.ts');
    expect(stepRows[0]!.querySelectorAll('.payload-label')).toHaveLength(0);
    expect(stepRows[1]!.textContent).toContain('INCOMPLETE_SOURCE');
  });
  it('labels shell tools as Bash consistently while retaining the actual tool name in raw data', () => {
    const data = share([tool({ type: 'shell', command: 'npm test', output: '' }, { name: 'shell' })]);
    const view = renderTimeline(data, messages.en);
    expect(view.querySelector('summary')!.textContent).toBe('Bash: npm test');
    expect(data.entries[0]!.item.name).toBe('shell');
  });
});
