import { execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { URL } from 'node:url';
import { toShare } from '../shared/convert';
import { lockContent } from '../shared/encryption';
import { MAX_SHARE_BYTES, SHARE_FILENAME, ShareError, isObject, type SessionMetadata, type ShareDocument } from '../shared/format';
import { readSnapshot, type Refetch } from '../shared/snapshot';
import { DEFAULT_VIEWER_URL, type ShareLink, type SharedSnapshot } from '../shared/plugin';
import { filePasswordStore, type PasswordStore } from './passwords';

export interface ShareSettings { viewerUrl?: string }
export interface ShareSource { session: SessionMetadata; refetch: Refetch }

export class ShareFailure extends Error {}

const messages = {
  login: '请在服务器安装 GitHub CLI（gh），并运行 gh auth login 登录。',
  token: 'GitHub token 被拒绝或缺少 gist 权限。请重新运行 gh auth login 授权。',
  viewer: '查看器地址无效。',
  snapshot: '读取会话快照失败。请稍后重试。',
  network: '无法连接 GitHub 或读取上传结果。请检查服务器网络后重试。',
  rate: 'GitHub 请求受限。请等待限流解除后重试。',
  notShare: '这不是 Chat-Share 创建的 Gist，已拒绝删除。',
};

const GIST_DESCRIPTION = 'Chat-Share snapshot';
const GIST_LOCKED = 'locked';
const GIST_PAGE_SIZE = 100;
const savedPasswords = filePasswordStore();
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

function isRateLimited(response: Response): boolean {
  return response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')));
}

function assertReadable(response: Response): void {
  if (isRateLimited(response)) throw new ShareFailure(messages.rate);
  if ([401, 403].includes(response.status)) throw new ShareFailure(messages.token);
  if (!response.ok) throw new ShareFailure(messages.network);
}

/** Bounds one GitHub exchange, including its body, and never propagates a raw error. */
async function withGitHubTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10_000);
  try { return await run(controller.signal); } catch (error) {
    if (error instanceof ShareFailure) throw error;
    throw new ShareFailure(messages.network);
  } finally { clearTimeout(timeout); }
}

/** Only this server module sends credentials and content to GitHub. No automatic POST retry. */
export async function uploadShare(share: ShareDocument, settings: ShareSettings, dependencies: {
  fetch?: typeof fetch; readGh?: () => Promise<string>; passwords?: PasswordStore;
} = {}, password?: string): Promise<SharedSnapshot> {
  const viewer = viewerBase(settings.viewerUrl);
  const serialized = JSON.stringify(share), content = password ? await lockContent(serialized, password) : serialized, bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_SHARE_BYTES) throw new ShareFailure(`${password ? '会话加密后过大' : '会话过大'}：${bytes.toLocaleString('zh-CN')} 字节；上限为 10,000,000 字节。`);
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
        description: `${GIST_DESCRIPTION} ${share.session.id} ${encodeURIComponent(share.snapshot.epoch)} ${share.snapshot.window.maxSeq}${password ? ` ${GIST_LOCKED}` : ''}`,
        files: { [SHARE_FILENAME]: { content } } }),
    });
    if (response.ok) value = await response.json();
  } catch { throw new ShareFailure(messages.network); }
  finally { clearTimeout(timeout); }
  if (isRateLimited(response)) throw new ShareFailure(messages.rate);
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
  const shared: SharedSnapshot = { url: viewer.href, version: { epoch: share.snapshot.epoch, maxSeq: share.snapshot.window.maxSeq } };
  if (!password) return shared;
  // The link already exists and works; losing this copy only means re-sharing after a restart.
  await (dependencies.passwords ?? savedPasswords).save(value.id, password).catch(() => console.error('保存分享密码失败。'));
  return { ...shared, locked: true, password };
}

interface ShareGist { id: string; login: string; createdAt: string; description: string }

/** Decides what is listed and what may be deleted. GitHub records no creator, so this matches the shape Chat-Share writes. */
function asShareGist(gist: unknown): ShareGist | undefined {
  if (!isObject(gist) || gist.public !== false || typeof gist.description !== 'string' || typeof gist.created_at !== 'string'
    || typeof gist.id !== 'string' || !GIST_ID.test(gist.id) || !isObject(gist.owner) || typeof gist.owner.login !== 'string' || !GITHUB_LOGIN.test(gist.owner.login)
    || !isObject(gist.files) || !isObject(gist.files[SHARE_FILENAME])) return undefined;
  if (gist.description !== GIST_DESCRIPTION && !gist.description.startsWith(`${GIST_DESCRIPTION} `)) return undefined;
  return { id: gist.id, login: gist.owner.login, createdAt: gist.created_at, description: gist.description };
}

/** Legacy Gists carry a bare description, so they have no agent or version. */
function parseDescription(description: string): { agentId: string; version: SharedSnapshot['version']; locked: boolean } | undefined {
  const parts = description.slice(GIST_DESCRIPTION.length + 1).split(' ');
  if (parts.length !== 3 && !(parts.length === 4 && parts[3] === GIST_LOCKED)) return undefined;
  const [agentId, encodedEpoch, seq] = parts as [string, string, string];
  const maxSeq = Number(seq);
  if (!agentId || !encodedEpoch || !/^\d+$/.test(seq) || !Number.isSafeInteger(maxSeq)) return undefined;
  try {
    const epoch = decodeURIComponent(encodedEpoch);
    return epoch ? { agentId, version: { epoch, maxSeq }, locked: parts.length === 4 } : undefined;
  } catch { return undefined; }
}

async function listShareGists(dependencies: Parameters<typeof uploadShare>[2] = {}): Promise<ShareGist[]> {
  const token = await resolveToken(dependencies.readGh);
  const found: ShareGist[] = [];
  for (let page = 1; ; page++) {
    const gists = await withGitHubTimeout(async signal => {
      const response = await (dependencies.fetch ?? fetch)(`https://api.github.com/gists?per_page=${GIST_PAGE_SIZE}&page=${page}`, {
        redirect: 'error', signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      });
      assertReadable(response);
      const value: unknown = await response.json();
      if (!Array.isArray(value)) throw new ShareFailure(messages.network);
      return value as unknown[];
    });
    for (const gist of gists) {
      const share = asShareGist(gist);
      if (share) found.push(share);
    }
    if (gists.length < GIST_PAGE_SIZE) return found;
  }
}

function viewerLink(viewer: URL, gist: ShareGist): string {
  const link = new URL(viewer);
  link.hash = `${gist.login}/${gist.id}`;
  return link.href;
}

/** GitHub is the record of what is shared, so a Gist deleted to revoke its link stops being offered. */
export async function listShareLinks(settings: ShareSettings, dependencies: Parameters<typeof uploadShare>[2] = {}): Promise<Record<string, SharedSnapshot>> {
  const viewer = viewerBase(settings.viewerUrl);
  const newest = new Map<string, { createdAt: string; gistId: string; locked: boolean; share: SharedSnapshot }>();
  for (const gist of await listShareGists(dependencies)) {
    const parsed = parseDescription(gist.description);
    if (!parsed || (newest.get(parsed.agentId)?.createdAt ?? '') >= gist.createdAt) continue;
    newest.set(parsed.agentId, { createdAt: gist.createdAt, gistId: gist.id, locked: parsed.locked, share: { url: viewerLink(viewer, gist), version: parsed.version } });
  }
  const found = [...newest];
  const passwords = found.some(([, { locked }]) => locked) ? await (dependencies.passwords ?? savedPasswords).read().catch(() => ({} as Record<string, string>)) : {};
  return Object.fromEntries(found.map(([agentId, { gistId, locked, share }]) => {
    const password = passwords[gistId];
    return [agentId, locked ? { ...share, locked: true as const, ...(password ? { password } : {}) } : share];
  }));
}

/** Every live link, newest first. Unlike listShareLinks, a re-shared conversation keeps its older, still readable links. */
export async function listAllShareLinks(settings: ShareSettings, dependencies: Parameters<typeof uploadShare>[2] = {}): Promise<ShareLink[]> {
  const viewer = viewerBase(settings.viewerUrl);
  const links = (await listShareGists(dependencies)).map((gist): ShareLink => {
    const agentId = parseDescription(gist.description)?.agentId;
    return { gistId: gist.id, url: viewerLink(viewer, gist), createdAt: gist.createdAt, ...(agentId ? { agentId } : {}) };
  });
  return links.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.gistId.localeCompare(b.gistId));
}

/**
 * The gh token can delete any of the user's Gists, so re-check this one against GitHub rather than trust the caller.
 * Only the check's 404 means "already gone": DELETE also answers 404 for a token without the gist scope,
 * and reporting that as success would leave a live link looking revoked.
 */
export async function deleteShareLink(gistId: string, dependencies: Parameters<typeof uploadShare>[2] = {}): Promise<void> {
  if (!GIST_ID.test(gistId)) throw new ShareFailure(messages.notShare);
  const token = await resolveToken(dependencies.readGh);
  const url = `https://api.github.com/gists/${gistId}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const exists = await withGitHubTimeout(async signal => {
    const response = await (dependencies.fetch ?? fetch)(url, { redirect: 'error', signal, headers });
    if (response.status === 404) return false;
    assertReadable(response);
    if (!asShareGist(await response.json())) throw new ShareFailure(messages.notShare);
    return true;
  });
  if (!exists) return;
  await withGitHubTimeout(async signal => {
    const response = await (dependencies.fetch ?? fetch)(url, { method: 'DELETE', redirect: 'error', signal, headers });
    if (response.status === 404) throw new ShareFailure(messages.token);
    assertReadable(response);
  });
}

export async function shareSession(settings: ShareSettings, source: () => Promise<ShareSource>, dependencies: Parameters<typeof uploadShare>[2] = {}, locked = false): Promise<SharedSnapshot> {
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
  return uploadShare(share, settings, dependencies, locked ? String(randomInt(1_000_000)).padStart(6, '0') : undefined);
}
