import { editLines, toolSummary } from '../../shared/tools';
export { editLines, toolSummary } from '../../shared/tools';
import { isObject, type ShareDocument, type TimelineEntry } from '../../shared/format';
import { highlighted, markdownRenderer } from './markdown';
import { failedCountText, type Locale, type Translations } from './i18n';

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
function valueText(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? ''; }

export function stepSummary(entries: readonly TimelineEntry[], locale: 'en' | 'zh'): string {
  let thoughts = 0;
  const editedFiles = new Set<string>();
  let commands = 0;
  const readFiles = new Set<string>();
  let searches = 0;
  let fetches = 0;
  let subAgents = 0;
  let others = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const item = entry.item;
    if (item.type === 'reasoning') {
      thoughts++;
      while (entries[i + 1]?.item.type === 'reasoning') i++;
    } else if (item.type === 'tool_call') {
      const detail = isObject(item.detail) ? item.detail : {};
      const type = typeof detail.type === 'string' ? detail.type : '';
      if (type === 'shell') {
        commands++;
      } else if (type === 'edit' || type === 'write') {
        const path = typeof detail.filePath === 'string' && detail.filePath ? detail.filePath : `file_${editedFiles.size + 1}`;
        editedFiles.add(path);
      } else if (type === 'read') {
        const path = typeof detail.filePath === 'string' && detail.filePath ? detail.filePath : `file_${readFiles.size + 1}`;
        readFiles.add(path);
      } else if (type === 'search') {
        searches++;
      } else if (type === 'fetch') {
        fetches++;
      } else if (type === 'sub_agent') {
        subAgents++;
      } else {
        others++;
      }
    }
  }

  const parts: string[] = [];
  if (locale === 'zh') {
    if (thoughts) parts.push(`思考 ${thoughts} 次`);
    if (editedFiles.size) parts.push(`编辑 ${editedFiles.size} 个文件`);
    if (commands) parts.push(`运行 ${commands} 个命令`);
    if (readFiles.size) parts.push(`读取 ${readFiles.size} 个文件`);
    if (searches) parts.push(`搜索 ${searches} 次`);
    if (fetches) parts.push(`获取 ${fetches} 个链接`);
    if (subAgents) parts.push(`调用 ${subAgents} 个子代理`);
    if (others) parts.push(`使用 ${others} 个其他工具`);

    return parts.join('，');
  } else {
    if (thoughts) parts.push(thoughts === 1 ? 'thought 1 time' : `thought ${thoughts} times`);
    if (editedFiles.size) parts.push(editedFiles.size === 1 ? 'edited 1 file' : `edited ${editedFiles.size} files`);
    if (commands) parts.push(commands === 1 ? 'ran 1 command' : `ran ${commands} commands`);
    if (readFiles.size) parts.push(readFiles.size === 1 ? 'read 1 file' : `read ${readFiles.size} files`);
    if (searches) parts.push(searches === 1 ? 'searched 1 time' : `searched ${searches} times`);
    if (fetches) parts.push(fetches === 1 ? 'fetched 1 URL' : `fetched ${fetches} URLs`);
    if (subAgents) parts.push(subAgents === 1 ? 'called 1 subagent' : `called ${subAgents} subagents`);
    if (others) parts.push(others === 1 ? 'used 1 other tool' : `used ${others} other tools`);

    if (parts.length === 0) return '';
    const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    if (parts.length === 1) return capitalize(parts[0]!);
    if (parts.length === 2) return `${capitalize(parts[0]!)} and ${parts[1]!}`;
    return `${capitalize(parts.slice(0, -1).join(', '))} and ${parts[parts.length - 1]!}`;
  }
}

export function createIcon(name: string, size = 16): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', `icon icon-${name}`);
  svg.setAttribute('aria-hidden', 'true');

  const add = (tag: string, attrs: Record<string, string>) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  };

  switch (name) {
    case 'merged':
      add('path', { d: 'M2 4.5h2M2 8h2M2 11.5h2M6 4.5h8M6 8h8M6 11.5h8' });
      break;
    case 'shell':
      add('polyline', { points: '3 5 7 8 3 11' });
      add('line', { x1: '9', y1: '11', x2: '13', y2: '11' });
      break;
    case 'read':
      add('path', { d: 'M3 2h7l4 4v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z' });
      add('polyline', { points: '10 2 10 6 14 6' });
      break;
    case 'edit':
      add('path', { d: 'M11 2a1.5 1.5 0 0 1 2 2L4.5 12.5 2 13l.5-2.5L11 2z' });
      break;
    case 'write':
      add('path', { d: 'M8 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7L8 2z' });
      add('polyline', { points: '8 2 8 7 13 7' });
      add('line', { x1: '6', y1: '10', x2: '10', y2: '10' });
      break;
    case 'search':
      add('circle', { cx: '7', cy: '7', r: '4' });
      add('line', { x1: '10', y1: '10', x2: '13.5', y2: '13.5' });
      break;
    case 'fetch':
      add('circle', { cx: '8', cy: '8', r: '6' });
      add('line', { x1: '2', y1: '8', x2: '14', y2: '8' });
      add('path', { d: 'M8 2a9 9 0 0 1 0 12M8 2a9 9 0 0 0 0 12' });
      break;
    case 'sub_agent':
      add('circle', { cx: '8', cy: '3.5', r: '2' });
      add('circle', { cx: '4', cy: '12.5', r: '2' });
      add('circle', { cx: '12', cy: '12.5', r: '2' });
      add('path', { d: 'M8 5.5v3M8 8.5l-4 2M8 8.5l4 2' });
      break;
    case 'reasoning':
      add('path', { d: 'M8 2v2M8 12v2M2 8h2M12 8h2M3.8 3.8l1.4 1.4M10.8 10.8l1.4 1.4M3.8 12.2l1.4-1.4M10.8 5.2l1.4-1.4' });
      add('circle', { cx: '8', cy: '8', r: '2.5' });
      break;
    case 'chevron':
      add('polyline', { points: '5 3 10 8 5 13' });
      break;
    case 'copy':
      add('rect', { x: '5.5', y: '5.5', width: '8', height: '8', rx: '1.5' });
      add('path', { d: 'M3.5 10.5V3.5a1 1 0 0 1 1-1h7' });
      break;
    case 'check':
      add('polyline', { points: '3 8 6 11 13 4' });
      break;
    case 'error':
      add('circle', { cx: '8', cy: '8', r: '6' });
      add('line', { x1: '8', y1: '5', x2: '8', y2: '8' });
      add('circle', { cx: '8', cy: '11', r: '0.75' });
      break;
    case 'notification':
      add('path', { d: 'M8 2a5 5 0 0 0-5 5v3l-1.5 2h13L13 10V7a5 5 0 0 0-5-5z' });
      add('path', { d: 'M6.5 14a1.5 1.5 0 0 0 3 0' });
      break;
    case 'compaction':
      add('path', { d: 'M2 4h12M4 8h8M6 12h4' });
      break;
    case 'todo':
      add('polyline', { points: '3 8 6 11 13 4' });
      add('rect', { x: '2', y: '2', width: '12', height: '12', rx: '2' });
      break;
    case 'download':
      add('path', { d: 'M3 11v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2' });
      add('polyline', { points: '5 7.5 8 10.5 11 7.5' });
      add('line', { x1: '8', y1: '2.5', x2: '8', y2: '10.5' });
      break;
    case 'expand':
      add('polyline', { points: '4 6 8 2 12 6' });
      add('polyline', { points: '4 10 8 14 12 10' });
      break;
    case 'collapse':
      add('polyline', { points: '4 3 8 7 12 3' });
      add('polyline', { points: '4 13 8 9 12 13' });
      break;
    case 'sun':
      add('circle', { cx: '8', cy: '8', r: '3' });
      add('line', { x1: '8', y1: '1.5', x2: '8', y2: '3' });
      add('line', { x1: '8', y1: '13', x2: '8', y2: '14.5' });
      add('line', { x1: '1.5', y1: '8', x2: '3', y2: '8' });
      add('line', { x1: '13', y1: '8', x2: '14.5', y2: '8' });
      add('line', { x1: '3.4', y1: '3.4', x2: '4.5', y2: '4.5' });
      add('line', { x1: '11.5', y1: '11.5', x2: '12.6', y2: '12.6' });
      add('line', { x1: '3.4', y1: '12.6', x2: '4.5', y2: '11.5' });
      add('line', { x1: '11.5', y1: '4.5', x2: '12.6', y2: '3.4' });
      break;
    case 'moon':
      add('path', { d: 'M13.2 9.5a5.5 5.5 0 1 1-6.7-6.7 5 5 0 0 0 6.7 6.7z' });
      break;
    case 'theme_auto':
      add('rect', { x: '2', y: '3', width: '12', height: '8.5', rx: '1.5' });
      add('line', { x1: '8', y1: '11.5', x2: '8', y2: '14' });
      add('line', { x1: '5', y1: '14', x2: '11', y2: '14' });
      break;
    case 'typography':
      add('path', { d: 'M2 13.5L5.5 4h1L10 13.5M3.2 10.2h5.6' });
      add('path', { d: 'M10.8 13.5l1.8-4.8h.8l1.8 4.8M11.5 11.8h3' });
      break;
    case 'toc':
      add('line', { x1: '2.5', y1: '4', x2: '4.5', y2: '4' });
      add('line', { x1: '6.5', y1: '4', x2: '13.5', y2: '4' });
      add('line', { x1: '2.5', y1: '8', x2: '4.5', y2: '8' });
      add('line', { x1: '6.5', y1: '8', x2: '13.5', y2: '8' });
      add('line', { x1: '2.5', y1: '12', x2: '4.5', y2: '12' });
      add('line', { x1: '6.5', y1: '12', x2: '13.5', y2: '12' });
      break;
    case 'arrow_up':
      add('polyline', { points: '4 7 8 3 12 7' });
      add('line', { x1: '8', y1: '3', x2: '8', y2: '13' });
      break;
    case 'close':
      add('line', { x1: '3.5', y1: '3.5', x2: '12.5', y2: '12.5' });
      add('line', { x1: '12.5', y1: '3.5', x2: '3.5', y2: '12.5' });
      break;
    case 'link':
      add('path', { d: 'M6.5 9.5a3 3 0 0 0 4.24 0l2-2a3 3 0 0 0-4.24-4.24l-1 1' });
      add('path', { d: 'M9.5 6.5a3 3 0 0 0-4.24 0l-2 2a3 3 0 0 0 4.24 4.24l1-1' });
      break;
    default:
      add('rect', { x: '3', y: '3', width: '10', height: '10', rx: '2' });
      add('circle', { cx: '8', cy: '8', r: '1.5' });
      break;
  }
  return svg;
}

function getStepKind(item: Record<string, unknown>): string {
  if (item.type === 'reasoning') return 'reasoning';
  if (item.type === 'tool_call') {
    const detail = isObject(item.detail) ? item.detail : {};
    const type = typeof detail.type === 'string' ? detail.type : '';
    if (['shell', 'read', 'edit', 'write', 'search', 'fetch', 'sub_agent'].includes(type)) return type;
    return 'other';
  }
  return item.type as string;
}

function isFailed(item: Record<string, unknown>): boolean {
  if (item.type === 'error') return true;
  if (item.status === 'failed') return true;
  if (item.error !== null && item.error !== undefined) return true;
  return false;
}

export function attachLazyRender(disclosure: HTMLDetailsElement, renderFn: () => void): void {
  let rendered = false;
  const run = () => {
    if (rendered || !disclosure.open) return;
    rendered = true;
    renderFn();
  };
  disclosure.addEventListener('toggle', run);
  (disclosure as unknown as { renderLazy: () => void }).renderLazy = run;
}

function attachCopyHandlers(root: HTMLElement, t: Translations): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>('.copy-code-btn')) {
    button.addEventListener('click', async (e) => {
      e.stopPropagation();
      const codeBlock = button.closest('.code-block');
      const code = codeBlock?.querySelector('pre code')?.textContent ?? '';
      const label = button.querySelector('.copy-label');
      try {
        if (!navigator.clipboard?.writeText) throw new Error('No clipboard API');
        await navigator.clipboard.writeText(code);
        button.classList.add('copied');
        if (label) label.textContent = t.copied;
        setTimeout(() => {
          button.classList.remove('copied');
          if (label) label.textContent = t.copyCode;
        }, 1500);
      } catch {
        button.classList.add('copy-failed');
        if (label) label.textContent = t.copyFailed;
        setTimeout(() => {
          button.classList.remove('copy-failed');
          if (label) label.textContent = t.copyCode;
        }, 1500);
      }
    });
  }
}

export function renderTimeline(share: ShareDocument, t: Translations): HTMLElement {
  const locale: Locale = t.locale;
  const timeline = element('main', 'timeline');
  const markdown = markdownRenderer(t);

  function prose(text: string): HTMLElement {
    const node = element('div', 'markdown');
    node.innerHTML = markdown(text);
    attachCopyHandlers(node, t);
    return node;
  }

  function code(value: unknown, language = ''): HTMLElement {
    const pre = element('pre', 'output'), node = element('code');
    node.innerHTML = highlighted(valueText(value), language);
    pre.append(node);
    return pre;
  }

  function section(parent: HTMLElement, title: string, value: unknown, language = ''): void {
    if (value === undefined || value === null || value === '') return;
    if (isObject(value) && Object.keys(value).length === 0) return;
    parent.append(element('h3', 'payload-label', title), code(value, language));
  }

  function raw(parent: HTMLElement, entry: TimelineEntry): void {
    const more = element('details', 'raw-entry');
    more.append(element('summary', '', t.fullEntry));
    attachLazyRender(more, () => {
      more.append(code(entry, 'json'));
    });
    parent.append(more);
  }

  function marks(index: number): HTMLElement[] {
    const found = share.truncations.filter(mark => mark.entry === index);
    if (!found.length) return [];
    return [element('span', 'truncation', found.some(mark => mark.certainty === 'definite') ? t.truncated : t.possiblyTruncated)];
  }

  function toolBody(entry: TimelineEntry): HTMLElement {
    const body = element('div', 'disclosure-body');
    const item = entry.item;
    const detail = isObject(item.detail) ? item.detail : {};

    switch (detail.type) {
      case 'shell': {
        const panel = element('div', 'shell-panel');
        if (detail.cwd !== undefined && detail.cwd !== null && detail.cwd !== '') {
          panel.append(element('div', 'shell-cwd', valueText(detail.cwd)));
        }
        if (detail.exitCode !== undefined && detail.exitCode !== null && Number(detail.exitCode) !== 0) {
          panel.append(element('div', 'shell-exit', `exit ${detail.exitCode}`));
        }
        const cmdRow = element('div', 'shell-command');
        const promptSpan = element('span', 'shell-prompt', '$');
        const cmdCode = element('code', '', valueText(detail.command));
        cmdRow.append(promptSpan, cmdCode);
        panel.append(cmdRow);
        if (detail.output !== undefined && detail.output !== null && detail.output !== '') {
          const pre = element('pre', 'shell-output');
          const codeEl = element('code');
          codeEl.textContent = valueText(detail.output);
          pre.append(codeEl);
          panel.append(pre);
        }
        body.append(panel);
        break;
      }
      case 'edit': {
        const changes = editLines(detail);
        if (changes.lines.length) {
          const panel = element('div', 'edit-panel');
          const filePath = detail.filePath ?? detail.path;
          if (filePath !== undefined && filePath !== '') {
            const header = element('div', 'edit-header');
            header.append(element('code', 'edit-path', valueText(filePath)));
            panel.append(header);
          }
          const pre = element('pre', 'diff');
          let previousClass = '', group: string[] = [];
          const flush = () => {
            if (group.length) {
              const span = element('span', previousClass, group.join('\n'));
              pre.append(span);
            }
            group = [];
          };
          for (const line of changes.lines) {
            const patch = typeof detail.unifiedDiff === 'string' && detail.unifiedDiff !== '';
            const kind = line.startsWith('+') && !(patch && line.startsWith('+++ ')) ? 'added' : line.startsWith('-') && !(patch && line.startsWith('--- ')) ? 'removed' : '';
            if (kind !== previousClass) flush();
            previousClass = kind;
            group.push(line);
          }
          flush();
          panel.append(pre);
          body.append(panel);
          const extra = Object.fromEntries(Object.entries(detail).filter(([key]) => !['type', 'filePath', 'path', 'oldString', 'newString', 'unifiedDiff'].includes(key)));
          if (Object.keys(extra).length) section(body, t.input, extra, 'json');
        } else {
          section(body, t.input, detail, 'json');
        }
        break;
      }
      case 'unknown':
        section(body, t.input, detail.input, 'json');
        section(body, t.output, detail.output, 'json');
        break;
      case 'read':
      case 'write': {
        const filePath = detail.filePath ?? detail.path;
        if (filePath !== undefined || detail.content !== undefined) {
          const panel = element('div', `${detail.type}-panel tool-file-panel`);
          if (filePath !== undefined && filePath !== '') {
            const header = element('div', 'tool-file-header');
            header.append(element('code', 'tool-file-path', valueText(filePath)));
            panel.append(header);
          }
          if (detail.content !== undefined && detail.content !== '') {
            const pre = element('pre', 'output tool-file-content');
            const codeNode = element('code');
            codeNode.textContent = valueText(detail.content);
            pre.append(codeNode);
            panel.append(pre);
          }
          body.append(panel);
        }
        const extra = Object.fromEntries(
          Object.entries(detail).filter(([k]) => !['type', 'filePath', 'path', 'content'].includes(k))
        );
        if (Object.keys(extra).length) section(body, t.input, extra, 'json');
        break;
      }
      case 'search':
      case 'fetch': {
        const inputKeys = ['query', 'url', 'pattern', 'path', 'headers', 'options', 'params', 'body', 'method'];
        const inputData = Object.fromEntries(
          Object.entries(detail).filter(([k]) => inputKeys.includes(k) && detail[k] !== undefined && detail[k] !== '')
        );
        const extraInput = Object.fromEntries(
          Object.entries(detail).filter(([k]) => !['type', 'output', 'result', 'response', ...inputKeys].includes(k))
        );
        const combinedInput = { ...inputData, ...extraInput };
        if (Object.keys(combinedInput).length) {
          section(body, t.input, combinedInput, 'json');
        }
        const outputData = detail.output ?? detail.result ?? detail.response;
        if (outputData !== undefined && outputData !== null && outputData !== '') {
          section(body, t.output, outputData, typeof outputData === 'string' ? '' : 'json');
        }
        break;
      }
      case 'sub_agent':
        section(body, t.input, { subAgentType: detail.subAgentType, description: detail.description }, 'json');
        section(body, t.output, detail.log);
        break;
      case 'plain_text':
      case 'plan':
        section(body, t.output, detail.text);
        break;
      default:
        section(body, t.output, detail, 'json');
    }

    if (isObject(item.agentMessage)) section(body, t.output, item.agentMessage, 'json');
    if (item.error !== null && item.error !== undefined) section(body, t.error, item.error, 'json');
    raw(body, entry);
    return body;
  }

  function createStepRow(entry: TimelineEntry, entryIndex: number): HTMLDetailsElement {
    const item = entry.item;
    const kind = getStepKind(item);
    const failed = isFailed(item);

    const disclosure = element('details', `timeline-row step-row${failed ? ' failed' : ''}`);
    disclosure.dataset.type = item.type;

    const summary = element('summary', 'row-summary');

    const iconSlot = element('span', 'row-icon');
    const kindIcon = createIcon(kind, 14);
    kindIcon.classList.add('icon-kind');
    const expandIcon = createIcon('chevron', 14);
    expandIcon.classList.add('icon-expand');
    iconSlot.append(kindIcon, expandIcon);

    const label = element('span', 'row-label');
    label.textContent = item.type === 'tool_call' ? toolSummary(item, t)
      : item.type === 'reasoning' ? t.reasoning
      : item.type === 'compaction' ? t.compaction
      : item.type === 'todo' ? t.todo
      : item.type === 'notification' ? string(item.message) || t.notification
      : item.type === 'error' ? string(item.message) || t.error
      : item.type === 'plugin' ? string(item.kind) || 'Plugin' : item.type;

    summary.append(iconSlot, label);

    if (item.type === 'tool_call' && isObject(item.detail) && item.detail.type === 'edit') {
      const { added, removed } = editLines(item.detail);
      if (added || removed) {
        const stat = element('span', 'diff-stat');
        stat.append(
          element('span', 'positive', `+${added}`),
          document.createTextNode(' '),
          element('span', 'negative', `−${removed}`)
        );
        summary.append(stat);
      }
    }

    if (failed) {
      summary.append(element('span', 'badge failed-badge', t.failed));
    }

    summary.append(...marks(entryIndex));

    disclosure.append(summary);

    attachLazyRender(disclosure, () => {
      if (item.type === 'tool_call') disclosure.append(toolBody(entry));
      else {
        const body = element('div', 'disclosure-body');
        if (item.type === 'reasoning') {
          body.append(prose(string(item.text)));
          raw(body, entry);
        } else {
          body.append(code(entry, 'json'));
        }
        disclosure.append(body);
      }
    });

    return disclosure;
  }

  function createReasoningRow(group: { entry: TimelineEntry; index: number }[]): HTMLDetailsElement {
    const failed = group.some(g => isFailed(g.entry.item));

    const disclosure = element('details', `timeline-row step-row${failed ? ' failed' : ''}`);
    disclosure.dataset.type = 'reasoning';

    const summary = element('summary', 'row-summary');

    const iconSlot = element('span', 'row-icon');
    const kindIcon = createIcon('reasoning', 14);
    kindIcon.classList.add('icon-kind');
    const expandIcon = createIcon('chevron', 14);
    expandIcon.classList.add('icon-expand');
    iconSlot.append(kindIcon, expandIcon);

    const label = element('span', 'row-label');
    label.textContent = t.reasoning;
    summary.append(iconSlot, label);

    if (failed) {
      summary.append(element('span', 'badge failed-badge', t.failed));
    }

    for (const part of group) {
      summary.append(...marks(part.index));
    }

    disclosure.append(summary);

    attachLazyRender(disclosure, () => {
      const body = element('div', 'disclosure-body');
      for (const part of group) {
        body.append(prose(string(part.entry.item.text)));
      }
      for (const part of group) {
        raw(body, part.entry);
      }
      disclosure.append(body);
    });

    return disclosure;
  }

  let index = 0;
  while (index < share.entries.length) {
    const entry = share.entries[index]!;
    const item = entry.item;

    if (item.type === 'user_message' || item.type === 'assistant_message') {
      const isUser = item.type === 'user_message';
      const article = element('article', `message ${isUser ? 'user' : 'assistant'}`);
      article.id = `entry-${index}`;
      article.setAttribute('data-entry-index', String(index));
      article.setAttribute('aria-label', isUser ? t.you : t.assistant);

      const msgFooter = element('div', 'message-footer');
      const copyBtn = element('button', 'copy-msg-btn');
      copyBtn.type = 'button';
      copyBtn.setAttribute('aria-label', t.copyMessage);
      copyBtn.title = t.copyMessage;
      copyBtn.append(createIcon('copy', 13));
      copyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(string(item.text));
          copyBtn.replaceChildren(createIcon('check', 13));
          setTimeout(() => copyBtn.replaceChildren(createIcon('copy', 13)), 1500);
        } catch {
          // ignore
        }
      });
      msgFooter.append(copyBtn);

      if (isUser) {
        const text = string(item.text);
        const proseNode = prose(text);
        const lineCount = text.trim().split(/\r?\n/).length;
        const couldOverflow = lineCount > 4 || text.length > 320;
        if (couldOverflow) {
          article.classList.add('clamped', 'has-clamp');
          const clampWrapper = element('div', 'prose-clamp');
          clampWrapper.append(proseNode);
          const showFullBtn = element('button', 'show-full-btn', t.showFull);
          showFullBtn.type = 'button';
          showFullBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const clamped = article.classList.toggle('clamped');
            showFullBtn.textContent = clamped ? t.showFull : t.showLess;
          });
          article.append(clampWrapper, showFullBtn, msgFooter, ...marks(index));
        } else {
          article.append(proseNode, msgFooter, ...marks(index));
        }
      } else {
        article.append(prose(string(item.text)), msgFooter, ...marks(index));
      }
      timeline.append(article);
      index++;
      continue;
    }

    if (item.type === 'reasoning' || item.type === 'tool_call') {
      type StepDef =
        | { type: 'reasoning'; group: { entry: TimelineEntry; index: number }[] }
        | { type: 'tool_call'; entry: TimelineEntry; index: number };
      const steps: StepDef[] = [];
      const runEntries: { entry: TimelineEntry; index: number }[] = [];

      while (
        index < share.entries.length &&
        (share.entries[index]!.item.type === 'reasoning' || share.entries[index]!.item.type === 'tool_call')
      ) {
        const cur = { entry: share.entries[index]!, index };
        runEntries.push(cur);
        if (cur.entry.item.type === 'reasoning') {
          const group = [cur];
          while (share.entries[index + 1]?.item.type === 'reasoning') {
            index++;
            const next = { entry: share.entries[index]!, index };
            runEntries.push(next);
            group.push(next);
          }
          steps.push({ type: 'reasoning', group });
        } else {
          steps.push({ type: 'tool_call', entry: cur.entry, index: cur.index });
        }
        index++;
      }

      if (steps.length === 1) {
        // Single step run renders as that plain row with no extra level
        const single = steps[0]!;
        if (single.type === 'reasoning') {
          timeline.append(createReasoningRow(single.group));
        } else {
          timeline.append(createStepRow(single.entry, single.index));
        }
      } else {
        // Multi step run folds into merged row
        const failedCount = runEntries.filter(r => isFailed(r.entry.item)).length;
        const merged = element('details', 'timeline-row merged-row');
        merged.dataset.type = 'merged';

        const summary = element('summary', 'row-summary merged-summary');

        const iconSlot = element('span', 'row-icon');
        const kindIcon = createIcon('merged', 14);
        kindIcon.classList.add('icon-kind');
        const expandIcon = createIcon('chevron', 14);
        expandIcon.classList.add('icon-expand');
        iconSlot.append(kindIcon, expandIcon);

        const label = element('span', 'row-label');
        label.textContent = stepSummary(runEntries.map(r => r.entry), locale);
        summary.append(iconSlot, label);

        if (failedCount > 0) {
          const failedBadge = element(
            'span',
            'badge failed-badge',
            failedCountText(failedCount, locale)
          );
          summary.append(failedBadge);
        }

        const truncsInRun = runEntries.flatMap(r => share.truncations.filter(m => m.entry === r.index));
        if (truncsInRun.length > 0) {
          const isDefinite = truncsInRun.some(m => m.certainty === 'definite');
          summary.append(element('span', 'truncation', isDefinite ? t.truncated : t.possiblyTruncated));
        }

        merged.append(summary);

        const stepsContainer = element('div', 'merged-steps');
        for (const step of steps) {
          if (step.type === 'reasoning') {
            stepsContainer.append(createReasoningRow(step.group));
          } else {
            stepsContainer.append(createStepRow(step.entry, step.index));
          }
        }
        merged.append(stepsContainer);
        timeline.append(merged);
      }
      continue;
    }

    // Non-merged items: error, notification, compaction, todo, plugin, unknown
    const nonMergedRow = createStepRow(entry, index);
    nonMergedRow.classList.remove('step-row');
    nonMergedRow.classList.add('plain-row');
    timeline.append(nonMergedRow);
    index++;
  }

  if (!share.entries.length) timeline.append(element('p', 'empty', t.empty));
  return timeline;
}
