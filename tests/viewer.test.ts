import { describe, it, expect, vi, afterEach } from 'vitest';
import { editLines, renderTimeline, toolSummary, stepSummary, createIcon, createModelIcon, resolveModelIconKey } from '../viewer/src/render';
import { markdownRenderer, safeLink } from '../viewer/src/markdown';
import { rawUrl, loadShare } from '../viewer/src/load';
import { messages, browserLocale, questionsCountText } from '../viewer/src/i18n';
import { MAX_SHARE_BYTES } from '../shared/format';
import { toShare } from '../shared/convert';
import { maliciousShare, designShare, session, snapshot, entry, attack } from './fixtures';

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });
describe('safe, readable rendering', () => {
  it('renders future/plugin/notification items as collapsed rows, never drops unknown content', async () => {
    const share = maliciousShare(), node = renderTimeline(share, messages.en); document.body.append(node);
    const nonMessageCount = share.entries.filter(e => !['user_message', 'assistant_message'].includes(e.item.type)).length;
    // Exactly every non-message entry maps to exactly one details.timeline-row:not(.merged-row)
    const stepAndPlainRows = [...node.querySelectorAll('details.timeline-row:not(.merged-row)')];
    expect(stepAndPlainRows).toHaveLength(nonMessageCount);
    expect(stepAndPlainRows).toHaveLength(8);
    // Top-level structure: 4 messages, 2 merged runs, 1 single step row, 3 plain non-step rows = 10 children
    expect(node.children).toHaveLength(10);
    expect(node.querySelectorAll('details.timeline-row.merged-row')).toHaveLength(2);
    expect(node.querySelectorAll('.message')).toHaveLength(4);
    expect(stepAndPlainRows.every(row => !row.hasAttribute('open'))).toBe(true);

    const unknown = stepAndPlainRows.find(row => (row as HTMLElement).dataset.type?.startsWith('future')) as HTMLDetailsElement;
    expect(unknown).toBeDefined();
    unknown.open = true; unknown.dispatchEvent(new Event('toggle'));
    expect(unknown.textContent).toContain('"unknown": true');
  });

  it('opens all levels of maliciousShare() and designShare() and checks every entry content is reachable', () => {
    for (const share of [maliciousShare(), designShare()]) {
      const node = renderTimeline(share, messages.en);
      document.body.append(node);

      // Open all details rows and trigger lazy rendering
      for (const row of node.querySelectorAll<HTMLDetailsElement>('details')) {
        row.open = true;
        (row as unknown as { renderLazy?: () => void }).renderLazy?.();
        row.dispatchEvent(new Event('toggle'));
      }
      for (const raw of node.querySelectorAll<HTMLDetailsElement>('details.raw-entry')) {
        raw.open = true;
        (raw as unknown as { renderLazy?: () => void }).renderLazy?.();
        raw.dispatchEvent(new Event('toggle'));
      }

      // Exact count check for non-message entries
      const nonMessageEntries = share.entries.filter(e => !['user_message', 'assistant_message'].includes(e.item.type));
      const stepAndPlainRows = [...node.querySelectorAll('details.timeline-row:not(.merged-row)')];
      expect(stepAndPlainRows).toHaveLength(nonMessageEntries.length);

      // Verify reachability of entry contents in DOM
      for (const entry of share.entries) {
        const item = entry.item;
        if (item.type === 'user_message' || item.type === 'assistant_message') {
          const sample = (typeof item.text === 'string' ? item.text.replace(/^#+\s*/, '') : '').trim().slice(0, 20);
          expect(node.textContent).toContain(sample);
        } else if (item.type === 'tool_call') {
          expect(node.textContent).toContain(item.name);
        } else if (item.type === 'reasoning') {
          const sample = (typeof item.text === 'string' ? item.text : '').trim().slice(0, 25);
          expect(node.textContent).toContain(sample);
        } else if (item.type === 'notification' || item.type === 'error' || item.type === 'compaction') {
          const sample = (typeof item.message === 'string' ? item.message : '').trim().slice(0, 20);
          expect(node.textContent).toContain(sample);
        } else if (item.type === 'plugin') {
          expect(node.textContent).toContain(typeof item.kind === 'string' ? item.kind : 'Plugin');
        } else if (item.type === 'todo') {
          expect(node.textContent).toContain(messages.en.todo);
        } else {
          expect(node.textContent).toContain(item.type);
        }
      }

      document.body.replaceChildren();
    }
  });
  it('keeps HTML and executable protocols inert in messages and full tool output', () => {
    const node = renderTimeline(maliciousShare(), messages.en); document.body.append(node);
    for (const row of node.querySelectorAll<HTMLDetailsElement>('details')) { row.open = true; row.dispatchEvent(new Event('toggle')); }
    expect(node.querySelector('script, iframe, object, [onerror], [onclick]')).toBeNull();
    expect(node.querySelector('a[href^="javascript:"], a[href^="vbscript:"], a[href^="#"]')).toBeNull();
    expect(node.textContent).toContain('globalThis.__xssExecuted');
    expect(node.querySelectorAll('img').length).toBe(1);
  });
  it('retains external images but replaces local images; rejects disguised executable links', () => {
    const render = markdownRenderer(messages.en), html = render(attack + '\n![local](file:///private.png)\n![remote](https://example.com/a.png)');
    const host = document.createElement('div'); host.innerHTML = html;
    expect(host.querySelectorAll('img')).toHaveLength(1);
    expect(host.querySelector('img')!.src).toBe('https://example.com/a.png');
    for (const url of ['javascript:alert(1)', 'data:text/html,attack', 'file:///private', 'vbscript:attack', '#payload', '/relative']) expect(safeLink(url)).toBe(false);
    expect(safeLink('mailto:person@example.com')).toBe(true);
  });
  it('gives commands and code changes useful summaries and real diff signs', () => {
    expect(toolSummary({ name: 'Bash', detail: { type: 'shell', command: 'npm test' } }, messages.en)).toBe('Bash: npm test');
    const share = toShare(session, snapshot, [entry({ type: 'tool_call', name: 'Edit', detail: { type: 'edit', filePath: '/synthetic/a.ts', oldString: 'one\n', newString: 'two\nthree\nfour\n' } })]);
    const node = renderTimeline(share, messages.en); const row = node.querySelector('details')!; row.open = true; row.dispatchEvent(new Event('toggle'));
    expect(row.querySelector('summary')!.textContent).toContain('Edit: a.ts+3 −1');
    expect(row.querySelector('.diff .added')!.textContent).toBe('+two\n+three\n+four');
    expect(row.querySelector('.diff .removed')!.textContent).toBe('-one');
  });
  it('keeps large unrelated edits complete without unbounded diff work', () => {
    const oldString = 'before\n'.repeat(1500), newString = 'after\n'.repeat(1500);
    const changes = editLines({ oldString, newString });
    expect(changes.added).toBe(1500); expect(changes.removed).toBe(1500);
    expect(changes.lines.join('\n')).toContain('-before'); expect(changes.lines.join('\n')).toContain('+after');
  });
  it('counts added increment expressions rather than mistaking them for patch headers', () => {
    const changes = editLines({ unifiedDiff: '--- a/count.ts\n+++ b/count.ts\n@@ -1 +1 @@\n-count = count + 1;\n+++count;\n' });
    expect(changes.added).toBe(1); expect(changes.removed).toBe(1);
  });
  it('follows browser language with an English fallback', () => {
    expect(browserLocale(['zh-TW', 'en'])).toBe('zh'); expect(browserLocale(['fr-FR'])).toBe('en');
    expect(browserLocale(['en', 'zh-CN'])).toBe('en');
  });
});

describe('raw Gist loading boundary', () => {
  const fragment = '#synthetic-user/00000000000000000000000000000001';
  it('accepts only a username/id fragment and uses the fixed raw filename', () => {
    expect(rawUrl(fragment)).toBe('https://gist.githubusercontent.com/synthetic-user/00000000000000000000000000000001/raw/chat-share.json');
    for (const payload of ['#<script>alert(1)</script>', '#user/../../x', '#user/id?token=secret', '#javascript:alert(1)']) expect(() => rawUrl(payload)).toThrow('invalid');
  });
  it('still finds the share when a copied link and password were pasted into the address bar together', () => {
    for (const tail of ['%E5%AF%86%E7%A0%81%EF%BC%9A482913', '%20%E5%AF%86%E7%A0%81%EF%BC%9A482913', '%0A%E5%AF%86%E7%A0%81']) {
      expect(rawUrl(fragment + tail)).toBe(rawUrl(fragment));
    }
    for (const tail of ['/../../x', '?token=secret', '%3Cscript%3E']) expect(() => rawUrl(fragment + tail)).toThrow('invalid');
  });
  it('fetches without credentials and validates the returned document', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(maliciousShare()))); vi.stubGlobal('fetch', fetch);
    expect((await loadShare(fragment)).version).toBe(1);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', mode: 'cors' });
  });
  it('distinguishes deleted, network, invalid, and declared oversized shares', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 404 })).mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(new Response('bad JSON')).mockResolvedValueOnce(new Response('', { headers: { 'content-length': String(MAX_SHARE_BYTES + 1) } }));
    vi.stubGlobal('fetch', fetch);
    for (const code of ['not-found', 'load', 'invalid', 'oversized']) await expect(loadShare(fragment)).rejects.toThrow(code);
  });
  it('enforces streamed byte size when content-length is absent', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_SHARE_BYTES)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)));
    await expect(loadShare(fragment)).rejects.toThrow('oversized'); expect(cancelled).toBe(true);
  });
});

describe('merged step runs and boundary conditions', () => {
  it('folds consecutive reasoning and tool_call entries into one merged row with summary and inner step rows', () => {
    const entries = [
      entry({ type: 'user_message', text: 'Run the tests' }, 1),
      entry({ type: 'reasoning', text: 'Let me check existing tests first.' }, 2),
      entry({ type: 'tool_call', callId: 'r1', name: 'Read', status: 'completed', error: null, detail: { type: 'read', filePath: '/app/test.ts' } }, 3),
      entry({ type: 'tool_call', callId: 's1', name: 'Bash', status: 'completed', error: null, detail: { type: 'shell', command: 'npm test' } }, 4),
      entry({ type: 'assistant_message', text: 'Tests completed.' }, 5),
    ];
    const share = toShare(session, snapshot, entries);
    const node = renderTimeline(share, messages.en);
    document.body.append(node);

    // Structure: 1 user msg + 1 merged row + 1 assistant msg = 3 children
    expect(node.children).toHaveLength(3);
    const merged = node.querySelectorAll('.timeline-row.merged-row');
    expect(merged).toHaveLength(1);
    const mergedRow = merged[0] as HTMLDetailsElement;
    expect(mergedRow.open).toBe(false);
    expect(mergedRow.querySelector('.row-label')?.textContent).toBe('Thought 1 time, ran 1 command and read 1 file');

    // Both merged row and inner steps have icon swap and no right chevron
    const mergedSummary = mergedRow.querySelector('summary')!;
    expect(mergedSummary.querySelector('.row-icon .icon-kind')).not.toBeNull();
    expect(mergedSummary.querySelector('.row-icon .icon-expand')).not.toBeNull();
    expect(mergedSummary.querySelector('.chevron-slot')).toBeNull();

    // Inner step rows inside the merged row
    const innerSteps = mergedRow.querySelectorAll('.timeline-row.step-row');
    expect(innerSteps).toHaveLength(3);
    for (const step of innerSteps) {
      const summary = step.querySelector('summary')!;
      expect(summary.querySelector('.row-icon .icon-kind')).not.toBeNull();
      expect(summary.querySelector('.row-icon .icon-expand')).not.toBeNull();
      expect(summary.querySelector('.chevron-slot')).toBeNull();
    }
  });

  it('renders a single-step run as a plain row with no extra level', () => {
    const entries = [
      entry({ type: 'user_message', text: 'Read the file' }, 1),
      entry({ type: 'tool_call', callId: 'r1', name: 'Read', status: 'completed', error: null, detail: { type: 'read', filePath: '/app/a.ts' } }, 2),
      entry({ type: 'assistant_message', text: 'Done.' }, 3),
    ];
    const share = toShare(session, snapshot, entries);
    const node = renderTimeline(share, messages.en);
    document.body.append(node);

    // Single step run should not have an outer merged-row
    expect(node.querySelectorAll('.timeline-row.merged-row')).toHaveLength(0);
    const stepRows = node.querySelectorAll('.timeline-row');
    expect(stepRows).toHaveLength(1);
    expect(stepRows[0]!.classList.contains('merged-row')).toBe(false);
    expect(stepRows[0]!.querySelector('summary')?.textContent).toContain('Read: a.ts');
  });

  it('splits runs when an error row occurs, keeping error as its own row', () => {
    const entries = [
      entry({ type: 'tool_call', callId: 't1', name: 'Read', status: 'completed', error: null, detail: { type: 'read', filePath: '/app/1.ts' } }, 1),
      entry({ type: 'error', message: 'Daemon disconnected' }, 2),
      entry({ type: 'tool_call', callId: 't2', name: 'Bash', status: 'completed', error: null, detail: { type: 'shell', command: 'npm start' } }, 3),
      entry({ type: 'tool_call', callId: 't3', name: 'Bash', status: 'completed', error: null, detail: { type: 'shell', command: 'npm test' } }, 4),
    ];
    const share = toShare(session, snapshot, entries);
    const node = renderTimeline(share, messages.en);
    document.body.append(node);

    // Top-level timeline children:
    // 1: single-step tool run t1 (plain row)
    // 2: error row
    // 3: 2-step merged run [t2, t3]
    const topRows = [...node.querySelectorAll(':scope > details.timeline-row')];
    expect(topRows).toHaveLength(3);
    expect((topRows[0] as HTMLElement).dataset.type).toBe('tool_call');
    expect(topRows[0]!.classList.contains('merged-row')).toBe(false);
    expect((topRows[1] as HTMLElement).dataset.type).toBe('error');
    expect(topRows[2]!.classList.contains('merged-row')).toBe(true);
  });

  it('keeps failure and truncation visible on collapsed merged rows and never hides them by folding', () => {
    const entries = [
      entry({ type: 'tool_call', callId: 't1', name: 'Bash', status: 'failed', error: 'exit 1', detail: { type: 'shell', command: 'npm test', output: 'failed' } }, 1),
      entry({ type: 'tool_call', callId: 't2', name: 'Read', status: 'completed', error: null, detail: { type: 'read', filePath: '/app/2.ts' } }, 2),
    ];
    const share = toShare(session, snapshot, entries);
    // Mark entry 0 (t1) as truncated
    share.truncations.push({ entry: 0, path: ['detail', 'output'], certainty: 'definite' });

    const node = renderTimeline(share, messages.en);
    document.body.append(node);

    const merged = node.querySelector('.timeline-row.merged-row') as HTMLDetailsElement;
    expect(merged).toBeDefined();
    expect(merged.open).toBe(false);

    // While collapsed, outer merged summary should NOT show failure badge
    const summary = merged.querySelector('summary')!;
    expect(summary.querySelector('.failed-badge')).toBeNull();

    // The individual failed tool step inside merged has the failed badge
    const failedStep = merged.querySelector('.timeline-row.step-row.failed')!;
    expect(failedStep).not.toBeNull();
    const subBadge = failedStep.querySelector('.failed-badge');
    expect(subBadge).not.toBeNull();
    expect(subBadge!.textContent).toBe(messages.en.failed);

    const truncBadge = summary.querySelector('.truncation');
    expect(truncBadge).not.toBeNull();
    expect(truncBadge!.textContent).toBe(messages.en.truncated);

    // When in Chinese
    const nodeZh = renderTimeline(share, messages.zh);
    const mergedZh = nodeZh.querySelector('.timeline-row.merged-row')!;
    expect(mergedZh.querySelector('summary')!.querySelector('.failed-badge')).toBeNull();
    const failedStepZh = mergedZh.querySelector('.timeline-row.step-row.failed')!;
    expect(failedStepZh.querySelector('.failed-badge')?.textContent).toBe(messages.zh.failed);
    expect(mergedZh.querySelector('.truncation')?.textContent).toBe(messages.zh.truncated);
  });

  it('does not fold non-merged items: notification, compaction, plugin, todo, and future types', () => {
    const entries = [
      entry({ type: 'notification', level: 'info', message: 'Hello note' }, 1),
      entry({ type: 'compaction', message: 'Compacted 10 lines' }, 2),
      entry({ type: 'plugin', kind: 'Git summary', id: 'p1', pluginId: 'git' }, 3),
      entry({ type: 'todo', items: [{ text: 'Clean code', completed: false }] }, 4),
      entry({ type: 'future_widget', data: { value: 42 } }, 5),
    ];
    const share = toShare(session, snapshot, entries);
    const node = renderTimeline(share, messages.en);
    document.body.append(node);

    expect(node.querySelectorAll('.merged-row')).toHaveLength(0);
    const rows = node.querySelectorAll('details.timeline-row');
    expect(rows).toHaveLength(5);
  });
});

describe('stepSummary generated text in zh and en with correct plurals', () => {
  it('generates accurate English summaries with plurals and commas', () => {
    // 1 thought
    expect(stepSummary([entry({ type: 'reasoning', text: 't1' })], 'en')).toBe('Thought 1 time');
    // Adjacent reasoning merges into 1 group
    expect(stepSummary([entry({ type: 'reasoning', text: 't1' }), entry({ type: 'reasoning', text: 't2' })], 'en')).toBe('Thought 1 time');
    // Non-adjacent reasoning counts each group (2 thoughts, 1 command)
    expect(stepSummary([
      entry({ type: 'reasoning', text: 't1' }),
      entry({ type: 'tool_call', name: 'Bash', detail: { type: 'shell', command: 'ls' } }),
      entry({ type: 'reasoning', text: 't2' }),
    ], 'en')).toBe('Thought 2 times and ran 1 command');
    // 1 edit, 2 commands
    expect(stepSummary([
      entry({ type: 'tool_call', name: 'Edit', detail: { type: 'edit', filePath: '/a.ts' } }),
      entry({ type: 'tool_call', name: 'Bash', detail: { type: 'shell', command: 'ls' } }),
      entry({ type: 'tool_call', name: 'Bash', detail: { type: 'shell', command: 'pwd' } }),
    ], 'en')).toBe('Edited 1 file and ran 2 commands');
    // 1 thought, 1 edit, 2 commands
    expect(stepSummary([
      entry({ type: 'reasoning', text: 'think' }),
      entry({ type: 'tool_call', name: 'Edit', detail: { type: 'edit', filePath: '/a.ts' } }),
      entry({ type: 'tool_call', name: 'Bash', detail: { type: 'shell', command: 'ls' } }),
      entry({ type: 'tool_call', name: 'Bash', detail: { type: 'shell', command: 'pwd' } }),
    ], 'en')).toBe('Thought 1 time, edited 1 file and ran 2 commands');
    // 2 files read, 1 search, 1 subagent
    expect(stepSummary([
      entry({ type: 'tool_call', name: 'Read', detail: { type: 'read', filePath: '/a.ts' } }),
      entry({ type: 'tool_call', name: 'Read', detail: { type: 'read', filePath: '/b.ts' } }),
      entry({ type: 'tool_call', name: 'Search', detail: { type: 'search', query: 'foo' } }),
      entry({ type: 'tool_call', name: 'Subagent', detail: { type: 'sub_agent', description: 'worker' } }),
    ], 'en')).toBe('Read 2 files, searched 1 time and called 1 subagent');
  });

  it('generates accurate Chinese summaries', () => {
    expect(stepSummary([entry({ type: 'reasoning', text: 't1' })], 'zh')).toBe('思考 1 次');
    // Adjacent reasoning merges into 1 group
    expect(stepSummary([entry({ type: 'reasoning', text: 't1' }), entry({ type: 'reasoning', text: 't2' })], 'zh')).toBe('思考 1 次');
    // Non-adjacent reasoning counts each group (2 thoughts, 1 command)
    expect(stepSummary([
      entry({ type: 'reasoning', text: 't1' }),
      entry({ type: 'tool_call', name: 'Bash', detail: { type: 'shell', command: 'ls' } }),
      entry({ type: 'reasoning', text: 't2' }),
    ], 'zh')).toBe('思考 2 次，运行 1 个命令');
    expect(stepSummary([
      entry({ type: 'tool_call', name: 'Edit', detail: { type: 'edit', filePath: '/a.ts' } }),
      entry({ type: 'tool_call', name: 'Bash', detail: { type: 'shell', command: 'ls' } }),
      entry({ type: 'tool_call', name: 'Bash', detail: { type: 'shell', command: 'pwd' } }),
    ], 'zh')).toBe('编辑 1 个文件，运行 2 个命令');
    expect(stepSummary([
      entry({ type: 'reasoning', text: 'think' }),
      entry({ type: 'tool_call', name: 'Edit', detail: { type: 'edit', filePath: '/a.ts' } }),
      entry({ type: 'tool_call', name: 'Bash', detail: { type: 'shell', command: 'ls' } }),
      entry({ type: 'tool_call', name: 'Bash', detail: { type: 'shell', command: 'pwd' } }),
    ], 'zh')).toBe('思考 1 次，编辑 1 个文件，运行 2 个命令');
  });
});

describe('user message clamping and detail panels', () => {
  it('clamps long user messages and provides show-full control while keeping all text in DOM', () => {
    const longText = 'This is a very long user prompt.\n'.repeat(10);
    const share = toShare(session, snapshot, [
      entry({ type: 'user_message', text: longText }),
      entry({ type: 'assistant_message', text: 'Got it.' }),
    ]);
    const node = renderTimeline(share, messages.en);
    document.body.append(node);

    const userMsg = node.querySelector('.message.user');
    expect(userMsg).not.toBeNull();
    expect(userMsg!.classList.contains('clamped')).toBe(true);

    const btn = userMsg!.querySelector('.show-full-btn') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe('Show full message');

    // Text remains reachable and in DOM
    expect(userMsg!.textContent).toContain('This is a very long user prompt.');

    // Clicking toggles clamping
    btn.click();
    expect(userMsg!.classList.contains('clamped')).toBe(false);
    expect(btn.textContent).toBe('Show less');

    btn.click();
    expect(userMsg!.classList.contains('clamped')).toBe(true);
    expect(btn.textContent).toBe('Show full message');
  });

  it('renders diff panels with colored lines and shell panels with command plus output', () => {
    const entries = [
      entry({ type: 'tool_call', name: 'Bash', detail: { type: 'shell', command: 'echo hi', output: 'hi\n' } }),
      entry({ type: 'tool_call', name: 'Edit', detail: { type: 'edit', filePath: '/app/a.ts', oldString: 'old\n', newString: 'new\n' } }),
    ];
    const share = toShare(session, snapshot, entries);
    const node = renderTimeline(share, messages.en);
    document.body.append(node);

    // Expand all step rows to verify lazy panel rendering
    for (const row of node.querySelectorAll<HTMLDetailsElement>('details')) {
      row.open = true;
      row.dispatchEvent(new Event('toggle'));
    }

    // Shell panel
    const shellPanel = node.querySelector('.shell-panel');
    expect(shellPanel).not.toBeNull();
    expect(shellPanel!.querySelector('.shell-command')?.textContent).toContain('echo hi');
    expect(shellPanel!.querySelector('.shell-output')?.textContent).toContain('hi');

    // Diff panel
    const diff = node.querySelector('.diff');
    expect(diff).not.toBeNull();
    expect(diff!.querySelector('.added')?.textContent).toBe('+new');
    expect(diff!.querySelector('.removed')?.textContent).toBe('-old');
  });

  it('renders code blocks in markdown with language header and copy button', () => {
    const mdText = 'Here is code:\n```ts\nconst x: number = 1;\n```\n';
    const share = toShare(session, snapshot, [
      entry({ type: 'assistant_message', text: mdText }),
    ]);
    const node = renderTimeline(share, messages.en);
    document.body.append(node);

    const codeBlock = node.querySelector('.code-block');
    expect(codeBlock).not.toBeNull();
    expect(codeBlock!.querySelector('.code-lang')?.textContent).toBe('ts');
    const copyBtn = codeBlock!.querySelector('.copy-code-btn') as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();
    expect(copyBtn.getAttribute('aria-label')).toBe('Copy code');

    // Clipboard failure handled quietly
    copyBtn.click();
    // No uncaught exceptions thrown
  });

  it('renders shell panels with cwd, valueText, and unhighlighted plain output', () => {
    const entries = [
      entry({
        type: 'tool_call',
        name: 'Bash',
        detail: {
          type: 'shell',
          command: { complexCommand: true },
          cwd: '/app/repo',
          output: 'PASS tests/demo.test.ts\nAll 1 passed.\n',
        },
      }),
    ];
    const node = renderTimeline(toShare(session, snapshot, entries), messages.en);
    document.body.append(node);
    const row = node.querySelector('details')!;
    row.open = true; row.dispatchEvent(new Event('toggle'));

    const cwd = node.querySelector('.shell-cwd');
    expect(cwd).not.toBeNull();
    expect(cwd!.textContent).toBe('/app/repo');

    const cmd = node.querySelector('.shell-command code');
    expect(cmd!.textContent).toContain('"complexCommand": true');

    const output = node.querySelector('.shell-output code');
    expect(output!.textContent).toContain('PASS tests/demo.test.ts');
    // Output must be escaped and plain, NOT highlighted as bash
    expect(output!.querySelectorAll('[class^="hljs-"]').length).toBe(0);
  });

  it('styles error rows with danger classes and accessible text cue in zh and en', () => {
    for (const [locale, expectedText] of [['en', 'Failed'], ['zh', '失败']] as const) {
      const share = toShare(session, snapshot, [
        entry({ type: 'error', message: 'Service unreachable' }),
      ]);
      const node = renderTimeline(share, messages[locale]);
      document.body.append(node);

      const errorRow = node.querySelector('details.timeline-row')!;
      expect(errorRow.classList.contains('failed')).toBe(true);
      const badge = errorRow.querySelector('.failed-badge');
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toBe(expectedText);

      document.body.replaceChildren();
    }
  });

  it('renders read and write with file path headers and content, omitting noise', () => {
    const entries = [
      entry({
        type: 'tool_call',
        name: 'Read',
        detail: {
          type: 'read',
          filePath: '/app/config.json',
          content: '{"port": 8080}',
          extraOption: 'audit-only',
        },
      }),
      entry({
        type: 'tool_call',
        name: 'Search',
        detail: {
          type: 'search',
          query: 'verifyToken',
          output: 'Found 3 occurrences',
        },
      }),
    ];
    const node = renderTimeline(toShare(session, snapshot, entries), messages.en);
    document.body.append(node);
    for (const row of node.querySelectorAll<HTMLDetailsElement>('details')) {
      row.open = true; row.dispatchEvent(new Event('toggle'));
    }

    // Read panel
    const fileHeader = node.querySelector('.tool-file-header');
    expect(fileHeader?.textContent).toBe('/app/config.json');
    const fileContent = node.querySelector('.tool-file-content');
    expect(fileContent?.textContent).toBe('{"port": 8080}');
    // Extra input only shows extraOption (no filePath or type)
    const inputSection = node.querySelector('.disclosure-body .payload-label');
    expect(inputSection?.textContent).toBe('Input');

    // Search panel
    expect(node.textContent).toContain('verifyToken');
    expect(node.textContent).toContain('Found 3 occurrences');
  });

  it('renders shell exit code quietly as .shell-exit only when present and non-zero', () => {
    const entries = [
      entry({
        type: 'tool_call',
        name: 'Bash',
        detail: { type: 'shell', command: 'git status', exitCode: 1, output: 'fatal: not a git repo\n' },
      }),
      entry({
        type: 'tool_call',
        name: 'Bash',
        detail: { type: 'shell', command: 'echo ok', exitCode: 0, output: 'ok\n' },
      }),
      entry({
        type: 'tool_call',
        name: 'Bash',
        detail: { type: 'shell', command: 'pwd', output: '/workspace\n' },
      }),
    ];
    const node = renderTimeline(toShare(session, snapshot, entries), messages.en);
    document.body.append(node);
    for (const row of node.querySelectorAll<HTMLDetailsElement>('details')) {
      row.open = true; row.dispatchEvent(new Event('toggle'));
    }
    const shellPanels = node.querySelectorAll('.shell-panel');
    expect(shellPanels).toHaveLength(3);

    // non-zero: exit 1
    const exitEl0 = shellPanels[0]!.querySelector('.shell-exit');
    expect(exitEl0).not.toBeNull();
    expect(exitEl0?.textContent).toBe('exit 1');

    // zero: no .shell-exit
    const exitEl1 = shellPanels[1]!.querySelector('.shell-exit');
    expect(exitEl1).toBeNull();

    // absent: no .shell-exit
    const exitEl2 = shellPanels[2]!.querySelector('.shell-exit');
    expect(exitEl2).toBeNull();

    document.body.replaceChildren();
  });

  it('provides icons and translations for reader controls and question counters', () => {
    expect(questionsCountText(1, 'en')).toBe('1 question');
    expect(questionsCountText(3, 'en')).toBe('3 questions');
    expect(questionsCountText(1, 'zh')).toBe('共 1 轮问答');
    expect(questionsCountText(5, 'zh')).toBe('共 5 轮问答');

    for (const icon of ['download', 'expand', 'collapse', 'sun', 'moon', 'theme_auto', 'typography', 'toc', 'arrow_up', 'close', 'link', 'check', 'chevron', 'shell', 'read', 'edit', 'write', 'search', 'fetch', 'sub_agent', 'reasoning', 'error', 'notification', 'compaction', 'todo', 'default']) {
      const el = createIcon(icon);
      expect(el.tagName.toLowerCase()).toBe('svg');
      expect(el.classList.contains(`icon-${icon}`)).toBe(true);
      expect(el.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(el.getAttribute('fill')).toBe('currentColor');
    }
  });

  it('resolves model provider/model name to corresponding brand icon and creates model icon', () => {
    expect(resolveModelIconKey('Anthropic', 'claude-3-5-sonnet-20241022')).toBe('claude');
    expect(resolveModelIconKey('OpenAI', 'gpt-4o')).toBe('openai');
    expect(resolveModelIconKey('Google', 'gemini-2.0-flash')).toBe('gemini');
    expect(resolveModelIconKey('DeepSeek', 'deepseek-reasoner')).toBe('deepseek');
    expect(resolveModelIconKey('Alibaba', 'qwen-2.5-coder-32b')).toBe('qwen');
    expect(resolveModelIconKey('xAI', 'grok-2')).toBe('grok');
    expect(resolveModelIconKey('Moonshot', 'moonshot-v1-8k')).toBe('kimi');
    expect(resolveModelIconKey(undefined, 'kimi-k1')).toBe('kimi');
    expect(resolveModelIconKey('MiniMax', 'abab6.5s')).toBe('minimax');
    expect(resolveModelIconKey('Zhipu', 'glm-4-plus')).toBe('zhipu');
    expect(resolveModelIconKey(undefined, 'cursor-small')).toBe('cursor');
    expect(resolveModelIconKey('CustomProvider', 'unknown-model')).toBe('sparkling_fill');

    const claudeIcon = createModelIcon({ provider: 'Anthropic', model: 'claude-3.5-sonnet' } as any, 20);
    expect(claudeIcon.tagName.toLowerCase()).toBe('svg');
    expect(claudeIcon.classList.contains('model-icon')).toBe(true);
    expect(claudeIcon.classList.contains('model-icon-claude')).toBe(true);
    expect(claudeIcon.getAttribute('role')).toBe('img');
    expect(claudeIcon.getAttribute('aria-label')).toBe('Anthropic · claude-3.5-sonnet');
    expect(claudeIcon.querySelector('title')?.textContent).toBe('Anthropic · claude-3.5-sonnet');
    expect(claudeIcon.getAttribute('width')).toBe('20');
    expect(claudeIcon.getAttribute('height')).toBe('20');

    const fallbackIcon = createModelIcon({} as any);
    expect(fallbackIcon.classList.contains('model-icon-sparkling_fill')).toBe(true);
  });
});
