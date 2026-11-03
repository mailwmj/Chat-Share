import { execFile } from 'node:child_process';
import { URL } from 'node:url';
import { toShare } from '../shared/convert';
import { MAX_SHARE_BYTES, SHARE_FILENAME, ShareError, isObject, type SessionMetadata, type ShareDocument } from '../shared/format';
import { readSnapshot, type Refetch } from '../shared/snapshot';

export interface ShareSettings { viewerUrl: string; fallbackToken: string }
export interface ShareSource { session: SessionMetadata; refetch: Refetch }

const messages = {
  login: '未登录 GitHub。请在服务器运行 gh auth login，或在插件设置填写具有 gist 权限的备用 token。',
  token: 'GitHub token 被拒绝或缺少 gist 权限。请更新 gh 登录授权或备用 token。',
  viewer: '未配置查看器地址。请先在插件设置填写查看器 URL。',
  snapshot: '读取会话快照失败。请稍后重试。',
  network: '无法连接 GitHub 或读取上传结果。请检查服务器网络后重试。',
  rate: 'GitHub 请求受限。请等待限流解除后重试。',
};

/** Never propagate execFile's error: it can contain stdout/stderr credentials. */
export function ghToken(): Promise<string> {
  return new Promise(resolve => {
    execFile('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      resolve(error ? '' : stdout.trim());
    });
  });
}

export async function resolveToken(fallback: string, readGh = ghToken): Promise<string> {
  let token: string;
  try { token = (await readGh()).trim(); } catch { token = ''; }
  token ||= fallback.trim();
  if (!token) throw new Error(messages.login);
  return token;
}

function viewerBase(value: string): URL {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url;
  } catch { throw new Error(messages.viewer); }
}

/** Only this server module sends credentials and content to GitHub. No automatic POST retry. */
export async function uploadShare(share: ShareDocument, settings: ShareSettings, dependencies: {
  fetch?: typeof fetch; readGh?: () => Promise<string>;
} = {}): Promise<{ url: string }> {
  const viewer = viewerBase(settings.viewerUrl);
  const content = JSON.stringify(share), bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_SHARE_BYTES) throw new Error(`会话过大：${bytes.toLocaleString('zh-CN')} 字节；上限为 10,000,000 字节。`);
  const token = await resolveToken(settings.fallbackToken, dependencies.readGh);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  let response: Response;
  let value: unknown;
  try {
    response = await (dependencies.fetch ?? fetch)('https://api.github.com/gists', {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({ public: false, description: 'Chat-Share snapshot', files: { [SHARE_FILENAME]: { content } } }),
    });
    if (response.ok) value = await response.json();
  } catch { throw new Error(messages.network); }
  finally { clearTimeout(timeout); }
  if (response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))) {
    throw new Error(messages.rate);
  }
  if ([401, 403, 404, 422].includes(response.status)) throw new Error(messages.token);
  if (!response.ok) throw new Error(messages.network);
  // Accept only fields that can form a viewer fragment, never an echoed message or token.
  if (!isObject(value) || value.public !== false || !isObject(value.owner) || typeof value.owner.login !== 'string'
    || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value.owner.login)
    || typeof value.id !== 'string' || !/^[a-f\d]{20,40}$/i.test(value.id)
    || value.owner.login.includes(token) || value.id.includes(token)) {
    // A successful POST may still have an unusable response. Remove its known Gist if possible.
    if (isObject(value) && typeof value.id === 'string' && /^[a-f\d]{20,40}$/i.test(value.id) && !value.id.includes(token)) {
      const cleanup = new AbortController(), timeout = setTimeout(() => cleanup.abort(), 10_000);
      try {
        await (dependencies.fetch ?? fetch)(`https://api.github.com/gists/${value.id}`, {
          method: 'DELETE', redirect: 'error', signal: cleanup.signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        });
      } catch { /* Best effort; preserve the original sanitized error. */ }
      finally { clearTimeout(timeout); }
    }
    throw new Error(messages.network);
  }
  viewer.hash = `${value.owner.login}/${value.id}`;
  return { url: viewer.href };
}

export async function shareSession(settings: ShareSettings, source: () => Promise<ShareSource>, dependencies: Parameters<typeof uploadShare>[2] = {}): Promise<{ url: string }> {
  viewerBase(settings.viewerUrl);
  let share: ShareDocument;
  try {
    const { session, refetch } = await source();
    const { snapshot, entries } = await readSnapshot(refetch);
    share = toShare(session, snapshot, entries);
  } catch (error) {
    if (error instanceof ShareError && error.code === 'oversized') {
      throw new Error(`会话过大：${error.bytes!.toLocaleString('zh-CN')} 字节；上限为 10,000,000 字节。`);
    }
    throw new Error(messages.snapshot);
  }
  return uploadShare(share, settings, dependencies);
}
