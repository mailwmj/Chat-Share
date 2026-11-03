import { MAX_SHARE_BYTES, SHARE_FILENAME, ShareError, parseShare, type ShareDocument } from '../../shared/format';

export function rawUrl(fragment: string): string {
  const match = /^#([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\/([a-f\d]{20,40})$/i.exec(fragment);
  if (!match) throw new ShareError('invalid');
  return `https://gist.githubusercontent.com/${match[1]}/${match[2]}/raw/${SHARE_FILENAME}`;
}

export async function loadShare(fragment: string, signal?: AbortSignal): Promise<ShareDocument> {
  let response: Response;
  try { response = await fetch(rawUrl(fragment), { credentials: 'omit', mode: 'cors', signal }); }
  catch (error) {
    if (error instanceof ShareError || (error instanceof Error && error.name === 'AbortError')) throw error;
    throw new ShareError('load');
  }
  if (response.status === 404) throw new ShareError('not-found');
  if (!response.ok) throw new ShareError('load');
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_SHARE_BYTES) { await response.body?.cancel(); throw new ShareError('oversized', declared); }
  if (!response.body) throw new ShareError('invalid');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_SHARE_BYTES) { await reader.cancel(); throw new ShareError('oversized', bytes); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof ShareError || (error instanceof Error && error.name === 'AbortError')) throw error;
    throw new ShareError(error instanceof TypeError ? 'invalid' : 'load');
  } finally { reader.releaseLock(); }
  return parseShare(text);
}
