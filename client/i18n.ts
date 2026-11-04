/** Plugin text follows the Paseo app's language; the browser's language applies until the host reports one. */
let hostLocale: string | undefined;
export function setLocale(value: string | undefined) { hostLocale = value; }

export function locale(): 'zh' | 'en' {
  const language = hostLocale ?? (typeof navigator !== 'undefined' ? navigator.language : undefined);
  return language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function t(zh: string, en: string): string {
  return locale() === 'zh' ? zh : en;
}

const errors: Record<string, string> = {
  '请在服务器安装 GitHub CLI（gh），并运行 gh auth login 登录。': 'Install GitHub CLI (gh) on the server and run gh auth login.',
  'GitHub token 被拒绝或缺少 gist 权限。请重新运行 gh auth login 授权。': 'The GitHub token was rejected or lacks gist permission. Run gh auth login again.',
  '查看器地址无效。': 'The viewer URL is invalid.',
  '读取会话快照失败。请稍后重试。': 'Could not read the conversation snapshot. Please try again.',
  '无法连接 GitHub 或读取上传结果。请检查服务器网络后重试。': 'Could not connect to GitHub or read the upload response. Check the server connection and try again.',
  'GitHub 请求受限。请等待限流解除后重试。': 'GitHub rate limit reached. Please try again later.',
  '这不是 Chat-Share 创建的 Gist，已拒绝删除。': 'This Gist was not created by Chat-Share and cannot be deleted here.',
  '插件设置无效。': 'Plugin settings are invalid.',
  '分享失败，请稍后重试。': 'Sharing failed. Please try again.',
  '读取分享链接失败，请稍后重试。': 'Could not load share links. Please try again.',
  '删除失败，请稍后重试。': 'Deletion failed. Please try again.',
};

export function translateError(message: string): string {
  if (locale() === 'zh') return message;
  const size = /^(会话加密后过大|会话过大)：([\d,]+) 字节；上限为 10,000,000 字节。$/.exec(message);
  if (size) return `${size[1] === '会话加密后过大' ? 'Encrypted conversation' : 'Conversation'} is too large: ${size[2]} bytes; the limit is 10,000,000 bytes.`;
  return errors[message] ?? message;
}
