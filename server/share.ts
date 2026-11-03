import { execFile } from 'node:child_process';
import { URL } from 'node:url';
import { toShare } from '../shared/convert';
import { MAX_SHARE_BYTES, SHARE_FILENAME, ShareError, isObject, type SessionMetadata, type ShareDocument } from '../shared/format';
import { readSnapshot, type Refetch } from '../shared/snapshot';
import { DEFAULT_VIEWER_URL, type SharedSnapshot } from '../shared/plugin';

export interface ShareSettings { viewerUrl?: string }
export interface ShareSource { session: SessionMetadata; refetch: Refetch }

export class ShareFailure extends Error {}

const messages = {
  login: '请在服务器安装 GitHub CLI（gh），并运行 gh auth login 登录。',
  token: 'GitHub token 被拒绝或缺少 gist 权限。请重新运行 gh auth login 授权。',
  viewer: '查看器地址无效，请在插件设置中修改。',
  snapshot: '读取会话快照失败。请稍后重试。',
  network: '无法连接 GitHub 或读取上传结果。请检查服务器网络后重试。',
  rate: 'GitHub 请求受限。请等待限流解除后重试。',
};

const GIST_DESCRIPTION = 'Chat-Share snapshot';
const GIST_PAGE_SIZE = 100;
const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i, GIST_ID = /^[a-f\d]{20,40}$/i;

/** Never propagate execFile's error: it can contain stdout/stderr credentials. */
export function ghToken(): Promise<string> {
  return new Promise(resolve => {
    execFile('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      resolve(error ? '' : stdout.trim());
    });
  });
}

export async function resolveToken(readGh = ghToken): Promise<string> {
  let token: string;
  try { token = (await readGh()).trim(); } catch { token = ''; }
  if (!token) throw new ShareFailure(messages.login);
  return token;
}

function viewerBase(value?: string): URL {
  try {
    const url = new URL(value?.trim() || DEFAULT_VIEWER_URL);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url;
  } catch { throw new ShareFailure(messages.viewer); }
}

/** Only this server module sends credentials and content to GitHub. No automatic POST retry. */
export async function uploadShare(share: ShareDocument, settings: ShareSettings, dependencies: {
  fetch?: typeof fetch; readGh?: () => Promise<string>;
} = {}): Promise<SharedSnapshot> {
  const viewer = viewerBase(settings.viewerUrl);
  const content = JSON.stringify(share), bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_SHARE_BYTES) throw new ShareFailure(`会话过大：${bytes.toLocaleString('zh-CN')} 字节；上限为 10,000,000 字节。`);
  const token = await resolveToken(dependencies.readGh);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  let response: Response;
  let value: unknown;
  try {
    response = await (dependencies.fetch ?? fetch)('https://api.github.com/gists', {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({ public: false,
        description: `${GIST_DESCRIPTION} ${share.session.id} ${encodeURIComponent(share.snapshot.epoch)} ${share.snapshot.window.maxSeq}`,
        files: { [SHARE_FILENAME]: { content } } }),
    });
    if (response.ok) value = await response.json();
  } catch { throw new ShareFailure(messages.network); }
  finally { clearTimeout(timeout); }
  if (response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))) {
    throw new ShareFailure(messages.rate);
  }
  if ([401, 403, 404, 422].includes(response.status)) throw new ShareFailure(messages.token);
  if (!response.ok) throw new ShareFailure(messages.network);
  // Accept only fields that can form a viewer fragment, never an echoed message or token.
  if (!isObject(value) || value.public !== false || !isObject(value.owner) || typeof value.owner.login !== 'string'
    || !GITHUB_LOGIN.test(value.owner.login)
    || typeof value.id !== 'string' || !GIST_ID.test(value.id)
    || value.owner.login.includes(token) || value.id.includes(token)) {
    // A successful POST may still have an unusable response. Remove its known Gist if possible.
    if (isObject(value) && typeof value.id === 'string' && GIST_ID.test(value.id) && !value.id.includes(token)) {
      const cleanup = new AbortController(), timeout = setTimeout(() => cleanup.abort(), 10_000);
      try {
        await (dependencies.fetch ?? fetch)(`https://api.github.com/gists/${value.id}`, {
          method: 'DELETE', redirect: 'error', signal: cleanup.signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        });
      } catch { /* Best effort; preserve the original sanitized error. */ }
      finally { clearTimeout(timeout); }
    }
    throw new ShareFailure(messages.network);
  }
  viewer.hash = `${value.owner.login}/${value.id}`;
  return { url: viewer.href, version: { epoch: share.snapshot.epoch, maxSeq: share.snapshot.window.maxSeq } };
}

/** GitHub is the record of what is shared, so a Gist deleted to revoke its link stops being offered. */
export async function listShareLinks(settings: ShareSettings, dependencies: Parameters<typeof uploadShare>[2] = {}): Promise<Record<string, SharedSnapshot>> {
  const viewer = viewerBase(settings.viewerUrl);
  const token = await resolveToken(dependencies.readGh);
  const newest = new Map<string, { createdAt: string; share: SharedSnapshot }>();
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    for (let page = 1; ; page++) {
      const response = await (dependencies.fetch ?? fetch)(`https://api.github.com/gists?per_page=${GIST_PAGE_SIZE}&page=${page}`, {
        redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      });
      if ([401, 403].includes(response.status)) throw new ShareFailure(messages.token);
      if (response.status === 429) throw new ShareFailure(messages.rate);
      if (!response.ok) throw new ShareFailure(messages.network);
      const gists: unknown = await response.json();
      if (!Array.isArray(gists)) throw new ShareFailure(messages.network);
      for (const gist of gists as unknown[]) {
        if (!isObject(gist) || gist.public !== false || typeof gist.description !== 'string' || typeof gist.created_at !== 'string'
          || typeof gist.id !== 'string' || !GIST_ID.test(gist.id) || !isObject(gist.owner) || typeof gist.owner.login !== 'string' || !GITHUB_LOGIN.test(gist.owner.login)
          || !isObject(gist.files) || !isObject(gist.files[SHARE_FILENAME])) continue;
        if (!gist.description.startsWith(`${GIST_DESCRIPTION} `)) continue;
        const parts = gist.description.slice(GIST_DESCRIPTION.length + 1).split(' ');
        if (parts.length !== 3) continue;
        const [agentId, encodedEpoch, seq] = parts as [string, string, string];
        const maxSeq = Number(seq);
        if (!agentId || !encodedEpoch || !/^\d+$/.test(seq) || !Number.isSafeInteger(maxSeq)
          || (newest.get(agentId)?.createdAt ?? '') >= gist.created_at) continue;
        let epoch: string;
        try { epoch = decodeURIComponent(encodedEpoch); } catch { continue; }
        if (!epoch) continue;
        const link = new URL(viewer);
        link.hash = `${gist.owner.login}/${gist.id}`;
        newest.set(agentId, { createdAt: gist.created_at, share: { url: link.href, version: { epoch, maxSeq } } });
      }
      if (gists.length < GIST_PAGE_SIZE) break;
    }
  } catch (error) {
    if (error instanceof ShareFailure) throw error;
    throw new ShareFailure(messages.network);
  } finally {
    clearTimeout(timeout);
  }
  return Object.fromEntries([...newest].map(([agentId, { share }]) => [agentId, share]));
}

export async function shareSession(settings: ShareSettings, source: () => Promise<ShareSource>, dependencies: Parameters<typeof uploadShare>[2] = {}): Promise<SharedSnapshot> {
  viewerBase(settings.viewerUrl);
  let share: ShareDocument;
  try {
    const { session, refetch } = await source();
    const { snapshot, entries } = await readSnapshot(refetch);
    share = toShare(session, snapshot, entries);
  } catch (error) {
    if (error instanceof ShareError && error.code === 'oversized') {
      throw new ShareFailure(`会话过大：${error.bytes!.toLocaleString('zh-CN')} 字节；上限为 10,000,000 字节。`);
    }
    throw new ShareFailure(messages.snapshot);
  }
  return uploadShare(share, settings, dependencies);
}
