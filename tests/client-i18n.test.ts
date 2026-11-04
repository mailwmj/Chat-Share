import { afterEach, describe, expect, it, vi } from 'vitest';
import { locale, t, translateError } from '../client/i18n';

afterEach(() => vi.unstubAllGlobals());

describe('plugin language', () => {
  it('uses Chinese for Chinese clients', () => {
    vi.stubGlobal('navigator', { language: 'zh-CN' });
    expect(locale()).toBe('zh');
    expect(t('分享', 'Share')).toBe('分享');
    expect(translateError('分享失败，请稍后重试。')).toBe('分享失败，请稍后重试。');
  });

  it('uses English for other clients and translates server errors', () => {
    vi.stubGlobal('navigator', { language: 'en-US' });
    expect(t('分享', 'Share')).toBe('Share');
    expect(translateError('分享失败，请稍后重试。')).toBe('Sharing failed. Please try again.');
    expect(translateError('会话加密后过大：10,000,001 字节；上限为 10,000,000 字节。'))
      .toBe('Encrypted conversation is too large: 10,000,001 bytes; the limit is 10,000,000 bytes.');
    vi.stubGlobal('navigator', { language: 'fr' });
    expect(locale()).toBe('en');
  });
});
