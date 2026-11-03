export const messages = {
  en: {
    locale: 'en' as const,
    title: 'Chat-Share', download: 'Download', expand: 'Expand all', collapse: 'Collapse all',
    loading: 'Loading conversation…', empty: 'This conversation is empty.',
    missing: 'Open a shared conversation link.', invalid: 'This share is invalid or uses an unsupported format.',
    notFound: 'This share is unavailable. It may have been deleted.', load: 'Could not load this conversation.',
    oversized: 'This share exceeds the 10 MB limit.', snapshot: 'The conversation changed while it was being read.',
    retry: 'Try again', untitled: 'Untitled conversation', you: 'You', assistant: 'Assistant',
    reasoning: 'Thinking', input: 'Input', output: 'Output', error: 'Error', fullEntry: 'Full entry',
    truncated: 'Truncated', possiblyTruncated: 'Possibly truncated', image: '[local image omitted]',
    notification: 'Notification', compaction: 'Context compacted', todo: 'Tasks',
    showFull: 'Show full message', showLess: 'Show less',
    copyCode: 'Copy code', copied: 'Copied!', copyFailed: 'Failed',
    failed: 'Failed',
    ranVerb: 'Ran', readVerb: 'Read', editVerb: 'Edited', writeVerb: 'Wrote',
    searchVerb: 'Searched', fetchVerb: 'Fetched', subAgentVerb: 'Subagent', thoughtVerb: 'Thought',
    ...toolLabels.en,
  },
  zh: {
    locale: 'zh' as const,
    title: 'Chat-Share', download: '下载', expand: '全部展开', collapse: '全部折叠',
    loading: '正在读取会话…', empty: '这个会话暂无内容。',
    missing: '请打开一个会话分享链接。', invalid: '分享内容无效或格式版本不受支持。',
    notFound: '分享已无法访问，可能已被删除。', load: '无法读取这个会话。',
    oversized: '分享内容超过 10 MB 上限。', snapshot: '读取期间会话发生了变化。',
    retry: '重试', untitled: '未命名会话', you: '你', assistant: '助手',
    reasoning: '思考', input: '输入', output: '输出', error: '错误', fullEntry: '完整条目',
    truncated: '已截断', possiblyTruncated: '可能已截断', image: '[本地图片已省略]',
    notification: '通知', compaction: '上下文已压缩', todo: '任务',
    showFull: '显示全部', showLess: '收起',
    copyCode: '复制', copied: '已复制', copyFailed: '复制失败',
    failed: '失败',
    ranVerb: '运行', readVerb: '读取', editVerb: '编辑', writeVerb: '写入',
    searchVerb: '搜索', fetchVerb: '获取', subAgentVerb: '子代理', thoughtVerb: '思考',
    ...toolLabels.zh,
  },
} as const;

export type Locale = keyof typeof messages;
export type Translations = { [K in keyof typeof messages.en]: string } & { locale: Locale };
export function browserLocale(languages: readonly string[]): Locale {
  return languages[0]?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
export function failedCountText(count: number, locale: Locale): string {
  return locale === 'zh' ? `${count} 次失败` : (count === 1 ? '1 failed' : `${count} failed`);
}
import { toolLabels } from '../../shared/tools';

