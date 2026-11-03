import { diffLines } from 'diff';
import { isObject } from './format';

export interface ToolLabels { read: string; edit: string; write: string; search: string; fetch: string; subAgent: string }
export const toolLabels: Record<'en' | 'zh', ToolLabels> = {
  en: { read: 'Read', edit: 'Edit', write: 'Write', search: 'Search', fetch: 'Fetch', subAgent: 'Subagent' },
  zh: { read: 'Read', edit: 'Edit', write: 'Write', search: 'Search', fetch: 'Fetch', subAgent: '子代理' },
};
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
function basename(path: string): string { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path; }

export function editLines(detail: Record<string, unknown>): { added: number; removed: number; lines: string[] } {
  const patch = string(detail.unifiedDiff);
  if (patch) {
    const lines = patch.split('\n');
    return { added: lines.filter(l => l.startsWith('+') && !l.startsWith('+++ ')).length,
      removed: lines.filter(l => l.startsWith('-') && !l.startsWith('--- ')).length, lines };
  }
  // An absent oldString is not an empty file: do not invent a diff for incomplete source.
  if (typeof detail.oldString !== 'string' || typeof detail.newString !== 'string') return { added: 0, removed: 0, lines: [] };
  // Bound edit-distance work on untrusted files. A whole-file replacement is still a complete diff.
  const countLines = (text: string) => text === '' ? 0 : text.split('\n').length - Number(text.endsWith('\n'));
  const changes = diffLines(detail.oldString, detail.newString, { maxEditLength: 1000 }) ?? [
    { value: detail.oldString, removed: true, added: false, count: countLines(detail.oldString) },
    { value: detail.newString, added: true, removed: false, count: countLines(detail.newString) },
  ];
  const lines: string[] = [];
  let added = 0, removed = 0;
  for (const change of changes) {
    const prefix = change.added ? '+' : change.removed ? '-' : ' ';
    if (change.added) added += change.count ?? 0;
    if (change.removed) removed += change.count ?? 0;
    if (change.value === '') continue;
    const content = change.value.endsWith('\n') ? change.value.slice(0, -1) : change.value;
    lines.push(...content.split('\n').map(line => prefix + line));
  }
  return { added, removed, lines };
}

export function toolSummary(item: Record<string, unknown>, t: ToolLabels): string {
  const detail = isObject(item.detail) ? item.detail : {};
  switch (detail.type) {
    case 'shell': return `Bash: ${string(detail.command).replace(/\s+/g, ' ')}`;
    case 'read': return `${t.read}: ${basename(string(detail.filePath))}`;
    case 'write': return `${t.write}: ${basename(string(detail.filePath))}`;
    case 'edit': return `${t.edit}: ${basename(string(detail.filePath))}`;
    case 'search': return `${string(item.name) || t.search}: ${string(detail.query)}`;
    case 'fetch': return `${t.fetch}: ${string(detail.url)}`;
    case 'sub_agent': return `${string(detail.subAgentType) || t.subAgent}: ${string(detail.description)}`;
    case 'plain_text': return string(detail.label) || string(item.name) || 'Tool';
    case 'plan': return string(item.name) || 'Plan';
    default: return string(item.name) || 'Tool';
  }
}

