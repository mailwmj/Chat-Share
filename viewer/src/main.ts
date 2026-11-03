import './style.css';
import { ShareError, type ShareDocument } from '../../shared/format';
import { downloadMarkdown } from '../../shared/download';
import { browserLocale, messages } from './i18n';
import { element, renderTimeline } from './render';
import { loadShare } from './load';

const locale = browserLocale(navigator.languages), t = messages[locale];
document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
const app = document.querySelector<HTMLDivElement>('#app')!;
let loading: AbortController | undefined;

export function showShare(share: ShareDocument): void {
  const title = share.session.title || t.untitled;
  document.title = `${title} · Chat-Share`;
  const header = element('header', 'toolbar'), inner = element('div', 'toolbar-inner');
  const heading = element('h1', '', title), actions = element('nav', 'actions');
  heading.title = title;
  const download = element('button', 'button', t.download), expand = element('button', 'button', t.expand);
  download.type = expand.type = 'button';
  const timeline = renderTimeline(share, t);
  const allRows = [...timeline.querySelectorAll<HTMLDetailsElement>('details.timeline-row')];
  const allClampedMsgs = [...timeline.querySelectorAll<HTMLElement>('.message.user.has-clamp')];
  let updateTimer: ReturnType<typeof setTimeout> | undefined;

  function updateButtonState(): void {
    const allRowsOpen = allRows.length === 0 || allRows.every(r => r.open);
    const allMsgsOpen = allClampedMsgs.length === 0 || allClampedMsgs.every(m => !m.classList.contains('clamped'));
    const allOpen = allRowsOpen && allMsgsOpen && (allRows.length > 0 || allClampedMsgs.length > 0);
    expand.textContent = allOpen ? t.collapse : t.expand;
    expand.setAttribute('aria-expanded', String(allOpen));
  }

  function scheduleUpdate(): void {
    if (updateTimer) return;
    updateTimer = setTimeout(() => {
      updateTimer = undefined;
      updateButtonState();
    }, 16);
  }

  expand.disabled = allRows.length === 0 && allClampedMsgs.length === 0;

  expand.addEventListener('click', () => {
    const shouldOpen = !allRows.every(r => r.open) || allClampedMsgs.some(m => m.classList.contains('clamped'));
    for (let i = 0; i < allRows.length; i++) {
      const row = allRows[i]!;
      row.open = shouldOpen;
      if (shouldOpen) (row as unknown as { renderLazy?: () => void }).renderLazy?.();
    }
    for (let i = 0; i < allClampedMsgs.length; i++) {
      const msg = allClampedMsgs[i]!;
      const btn = msg.querySelector<HTMLButtonElement>('.show-full-btn');
      if (shouldOpen) {
        msg.classList.remove('clamped');
        if (btn) btn.textContent = t.showLess;
      } else {
        msg.classList.add('clamped');
        if (btn) btn.textContent = t.showFull;
      }
    }
    updateButtonState();
  });

  timeline.addEventListener('toggle', (e) => {
    const target = e.target as HTMLDetailsElement;
    if (!target.classList?.contains('timeline-row')) return;
    scheduleUpdate();
  }, true);

  timeline.addEventListener('click', (e) => {
    const btn = (e.target as Element)?.closest?.('.show-full-btn');
    if (!btn) return;
    scheduleUpdate();
  });

  requestAnimationFrame(() => {
    for (let i = allClampedMsgs.length - 1; i >= 0; i--) {
      const article = allClampedMsgs[i]!;
      const clamp = article.querySelector('.prose-clamp');
      const btn = article.querySelector('.show-full-btn');
      if (clamp && btn && clamp.scrollHeight > 0 && clamp.scrollHeight <= clamp.clientHeight + 4) {
        article.classList.remove('clamped', 'has-clamp');
        btn.remove();
        allClampedMsgs.splice(i, 1);
      }
    }
    updateButtonState();
  });
  download.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([downloadMarkdown(share, locale)], { type: 'text/markdown;charset=utf-8' }));
    const link = element('a');
    link.href = url;
    link.download = `${title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 100) || 'conversation'}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  actions.append(download, expand); inner.append(heading, actions); header.append(inner);
  app.replaceChildren(header, timeline);
}

function showState(message: string, retry = false): void {
  document.title = 'Chat-Share';
  const header = element('header', 'toolbar'), inner = element('div', 'toolbar-inner');
  inner.append(element('h1', '', t.title)); header.append(inner);
  const state = element('main', 'state');
  state.setAttribute('role', retry ? 'alert' : 'status');
  state.append(element('p', '', message));
  if (retry) {
    const button = element('button', 'button', t.retry);
    button.addEventListener('click', () => void load()); state.append(button);
  }
  app.replaceChildren(header, state);
}

async function load(): Promise<void> {
  loading?.abort(); loading = new AbortController();
  const signal = loading.signal;
  if (!location.hash) { showState(t.missing); return; }
  showState(t.loading);
  try { const share = await loadShare(location.hash, signal); if (!signal.aborted) showShare(share); }
  catch (error) {
    if (signal.aborted) return;
    const key = error instanceof ShareError ? error.code : 'load';
    const text = key === 'not-found' ? t.notFound : key === 'oversized' ? t.oversized : key === 'invalid' ? t.invalid : t.load;
    const bytes = error instanceof ShareError && error.bytes ? ` (${new Intl.NumberFormat(locale).format(error.bytes)} ${locale === 'zh' ? '字节' : 'bytes'})` : '';
    showState(text + bytes, key === 'load');
  }
}
window.addEventListener('hashchange', () => void load());
void load();

// Vite removes this import and all local-file controls from the production graph.
if (import.meta.env.DEV) void import('./dev-preview').then(({ installLocalPreview }) => installLocalPreview(share => { loading?.abort(); showShare(share); }));
