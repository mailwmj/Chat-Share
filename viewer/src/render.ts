import { editLines, toolSummary } from '../../shared/tools';
export { editLines, toolSummary } from '../../shared/tools';
import { isObject, type ShareDocument, type TimelineEntry } from '../../shared/format';
import { highlighted, markdownRenderer } from './markdown';
import { type Locale, type Translations } from './i18n';

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

import { createIcon, createModelIcon, resolveModelIconKey } from './icons';
export { createIcon, createModelIcon, resolveModelIconKey };

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
          article.append(clampWrapper, showFullBtn, ...marks(index));
        } else {
          article.append(proseNode, ...marks(index));
        }
      } else {
        article.append(prose(string(item.text)), ...marks(index));
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
