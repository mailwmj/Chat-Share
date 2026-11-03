import { describe, it, expect } from 'vitest';
import MarkdownIt from 'markdown-it';
import { toShare } from '../shared/convert';
import { downloadMarkdown } from '../shared/download';
import { entry, session, snapshot } from './fixtures';

describe('M2 download polish', () => {
  it('keeps grep-friendly punctuation while preventing actual inline structure in headings', () => {
    const share = toShare({ ...session, title: 'README.md +1 [link](https://example.com) *literal*' }, snapshot,
      [entry({ type: 'future_kind', data: 'kept' }), entry({ type: 'tool_call', name: 'shell', status: 'completed', error: null, detail: { type: 'shell', command: 'echo +1', output: 'x'.repeat(65_536) } })]);
    const markdown = downloadMarkdown(share, 'en');
    expect(markdown.split('\n')[0]).toContain('# README.md +1 ');
    expect(markdown).toContain('## 1 · future_kind');
    expect(markdown).toContain('(item.detail.output)');
    const tokens = new MarkdownIt().parse(markdown, {});
    const title = tokens[1]!;
    expect(title.children?.some(token => ['link_open', 'em_open'].includes(token.type))).toBe(false);
  });
  it.each([
    ['en', 'Changes', true], ['zh', '改动', true], ['en', 'Changes', false], ['zh', '改动', false],
  ] as const)('labels %s edit changes (patch=%s)', (locale, label, patch) => {
    const detail = patch ? { type: 'edit', filePath: '/synthetic/a.ts', unifiedDiff: '-old\n+new\n' }
      : { type: 'edit', filePath: '/synthetic/a.ts', oldString: 'old\n', newString: 'new\n' };
    const markdown = downloadMarkdown(toShare(session, snapshot, [entry({ type: 'tool_call', name: 'Edit', detail: JSON.parse(JSON.stringify(detail)) })]), locale);
    expect(markdown).toContain(`### ${label}\n\n`);
    expect(markdown).not.toMatch(/### (Output|输出)/);
  });
  it.each([['en', 'Status', 'Failed'], ['zh', '状态', '失败']] as const)('localizes %s failure status', (locale, label, state) => {
    const share = toShare(session, snapshot, [entry({ type: 'tool_call', name: 'shell', status: 'failed', error: { content: 'synthetic failure' }, detail: { type: 'shell', command: 'false', output: '' } })]);
    const markdown = downloadMarkdown(share, locale);
    expect(markdown).toContain(`### ${label}`); expect(markdown).toContain(state);
    expect(markdown).not.toContain('### status');
  });
});
