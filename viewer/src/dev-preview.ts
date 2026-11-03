import { MAX_SHARE_BYTES, ShareError, parseShare, type ShareDocument } from '../../shared/format';
import { browserLocale, messages } from './i18n';
import './dev-preview.css';

export function installLocalPreview(show: (share: ShareDocument) => void): void {
  const t = messages[browserLocale(navigator.languages)];
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json,application/json';
  input.setAttribute('aria-label', browserLocale(navigator.languages) === 'zh' ? '打开本地分享文件' : 'Open local share');
  input.className = 'local-file';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > MAX_SHARE_BYTES) throw new ShareError('oversized', file.size);
      show(parseShare(await file.text()));
    } catch (error) { input.setCustomValidity(error instanceof ShareError && error.code === 'oversized' ? t.oversized : t.invalid); input.reportValidity(); }
  });
  document.body.append(input);
}
