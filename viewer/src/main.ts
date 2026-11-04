import './style.css';
import { ShareError, type ShareDocument, type TimelineEntry } from '../../shared/format';
import { downloadMarkdown } from '../../shared/download';
import { browserLocale, messages } from './i18n';
import { element, renderTimeline, createIcon } from './render';
import { loadShare } from './load';

const locale = browserLocale(navigator.languages), t = messages[locale];
document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
const app = document.querySelector<HTMLDivElement>('#app')!;
let loading: AbortController | undefined;

type Theme = 'auto' | 'light' | 'dark';
type FontSize = 'sm' | 'md' | 'lg' | 'xl';
type ContentWidth = 'normal' | 'wide' | 'full';
type ViewFilter = 'all' | 'chat_only';

const PREFS = {
  theme: 'chat-share-theme',
  fontSize: 'chat-share-font-size',
  width: 'chat-share-width',
  filter: 'chat-share-filter',
};

function getPref<T extends string>(key: string, fallback: T): T {
  try { return (localStorage.getItem(key) as T) || fallback; }
  catch { return fallback; }
}

function setPref(key: string, val: string): void {
  try { localStorage.setItem(key, val); }
  catch { /* private mode */ }
}

function applyTheme(theme: Theme): void {
  if (theme === 'auto') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
  setPref(PREFS.theme, theme);
}

function applyFontSize(size: FontSize): void {
  document.documentElement.dataset.fontSize = size;
  setPref(PREFS.fontSize, size);
}

function applyWidth(width: ContentWidth): void {
  document.documentElement.dataset.contentWidth = width;
  setPref(PREFS.width, width);
}

function applyFilter(filter: ViewFilter): void {
  document.documentElement.dataset.viewFilter = filter;
  setPref(PREFS.filter, filter);
}

// Initialize user preferences on page load
applyTheme(getPref(PREFS.theme, 'auto'));
applyFontSize(getPref(PREFS.fontSize, 'md'));
applyWidth(getPref(PREFS.width, 'normal'));
applyFilter(getPref(PREFS.filter, 'all'));

function isDark(): boolean {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === 'dark') return true;
  if (explicit === 'light') return false;
  return typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)').matches : false;
}

export function showShare(share: ShareDocument): void {
  const title = share.session.title || t.untitled;
  document.title = `${title} · Chat-Share`;
  const header = element('header', 'toolbar'), inner = element('div', 'toolbar-inner');
  const titleGroup = element('div', 'toolbar-title-group');
  const heading = element('h1', '', title);
  heading.title = title;
  const actions = element('nav', 'actions');

  // Extract user entries for TOC
  const userEntries: { entry: TimelineEntry; index: number; text: string }[] = [];
  share.entries.forEach((e, idx) => {
    if (e.item.type === 'user_message') {
      const text = typeof e.item.text === 'string' ? e.item.text : '';
      userEntries.push({ entry: e, index: idx, text });
    }
  });

  // Side Dash Outline Navigation
  let sideNav: HTMLElement | undefined;
  const dashButtons: HTMLButtonElement[] = [];

  if (userEntries.length > 0) {
    sideNav = element('nav', 'side-outline-nav');
    sideNav.setAttribute('aria-label', t.tableOfContents);

    userEntries.forEach((item, i) => {
      const dashBtn = element('button', 'side-dash-item') as HTMLButtonElement;
      dashBtn.type = 'button';
      dashBtn.setAttribute('data-entry-index', String(item.index));
      const cleanSnippet = item.text
        .replace(/^[#\s*`>_~-]+/gm, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60) || t.untitled;
      dashBtn.setAttribute('aria-label', `Q${i + 1}: ${cleanSnippet}`);

      const bar = element('span', 'side-dash-bar');
      const bubble = element('div', 'side-dash-bubble');
      const badge = element('span', 'side-dash-badge', `Q${i + 1}`);
      const textSpan = element('span', 'side-dash-text', cleanSnippet);
      bubble.append(badge, textSpan);
      dashBtn.append(bar, bubble);

      dashBtn.addEventListener('click', () => {
        const target = document.getElementById(`entry-${item.index}`);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          target.classList.remove('highlight-target');
          void target.offsetWidth;
          target.classList.add('highlight-target');
          setTimeout(() => target.classList.remove('highlight-target'), 2000);
        }
      });

      sideNav!.append(dashBtn);
      dashButtons.push(dashBtn);
    });
  }

  function updateActiveDash() {
    if (dashButtons.length === 0) return;
    let currentIdx = 0;
    for (let i = 0; i < userEntries.length; i++) {
      const el = document.getElementById(`entry-${userEntries[i]!.index}`);
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.top <= window.innerHeight * 0.45) {
          currentIdx = i;
        }
      }
    }
    dashButtons.forEach((btn, idx) => {
      btn.classList.toggle('active', idx === currentIdx);
    });
  }

  // 1. Expand / Collapse All Button
  const expand = element('button', 'button icon-btn', '');
  expand.type = 'button';
  expand.setAttribute('aria-label', t.expand);
  expand.title = t.expand;
  const expandIconSlot = element('span', 'btn-icon');
  expandIconSlot.append(createIcon('expand', 16));
  const expandSr = element('span', 'sr-only', t.expand);
  expand.append(expandIconSlot, expandSr);

  // 2. Direct Theme Switcher Button
  const themeToggle = element('button', 'button icon-btn theme-toggle-btn');
  themeToggle.type = 'button';
  const themeIconSlot = element('span', 'btn-icon');
  const themeSr = element('span', 'sr-only', t.toggleTheme);
  themeToggle.append(themeIconSlot, themeSr);

  function updateThemeUi(): void {
    const dark = isDark();
    themeIconSlot.replaceChildren(createIcon(dark ? 'sun' : 'moon', 16));
    const tip = dark ? t.themeLight : t.themeDark;
    themeToggle.title = tip;
    themeToggle.setAttribute('aria-label', tip);
    themeSr.textContent = tip;
  }
  updateThemeUi();

  // 3. Reading Preferences Popover (Aa)
  const readerBtn = element('button', 'button icon-btn reader-btn');
  readerBtn.type = 'button';
  readerBtn.setAttribute('aria-label', t.readingSettings);
  readerBtn.title = t.readingSettings;
  const readerSr = element('span', 'sr-only', t.readingSettings);
  readerBtn.append(createIcon('typography', 16), readerSr);

  const popover = element('div', 'reader-popover');
  popover.hidden = true;
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', t.readingSettings);

  const popHeader = element('div', 'popover-header');
  const popTitle = element('span', 'popover-title', t.readingSettings);
  const popClose = element('button', 'popover-close');
  popClose.type = 'button';
  popClose.setAttribute('aria-label', t.close);
  popClose.append(createIcon('close', 12));
  popHeader.append(popTitle, popClose);

  // Font size section
  const fsSection = element('div', 'popover-section');
  fsSection.append(element('span', 'popover-label', t.fontSize));
  const fsCtrl = element('div', 'segmented-control');
  const fsOptions: { size: FontSize; label: string }[] = [
    { size: 'sm', label: t.fontSizeSm },
    { size: 'md', label: t.fontSizeMd },
    { size: 'lg', label: t.fontSizeLg },
    { size: 'xl', label: t.fontSizeXl },
  ];
  const fsButtons: HTMLButtonElement[] = [];
  for (const opt of fsOptions) {
    const b = element('button', 'segment-btn', opt.label);
    b.type = 'button';
    b.addEventListener('click', () => {
      applyFontSize(opt.size);
      updatePopoverActive();
    });
    fsCtrl.append(b);
    fsButtons.push(b);
  }
  fsSection.append(fsCtrl);

  // Width section
  const widthSection = element('div', 'popover-section');
  widthSection.append(element('span', 'popover-label', t.contentWidth));
  const widthCtrl = element('div', 'segmented-control');
  const widthOptions: { width: ContentWidth; label: string }[] = [
    { width: 'normal', label: t.widthNormal },
    { width: 'wide', label: t.widthWide },
    { width: 'full', label: t.widthFull },
  ];
  const widthButtons: HTMLButtonElement[] = [];
  for (const opt of widthOptions) {
    const b = element('button', 'segment-btn', opt.label);
    b.type = 'button';
    b.addEventListener('click', () => {
      applyWidth(opt.width);
      updatePopoverActive();
    });
    widthCtrl.append(b);
    widthButtons.push(b);
  }
  widthSection.append(widthCtrl);

  // Appearance section
  const themeSection = element('div', 'popover-section');
  themeSection.append(element('span', 'popover-label', t.theme));
  const themeCtrl = element('div', 'segmented-control');
  const themeOptions: { theme: Theme; label: string }[] = [
    { theme: 'light', label: t.themeLight },
    { theme: 'auto', label: t.themeAuto },
    { theme: 'dark', label: t.themeDark },
  ];
  const themeButtons: HTMLButtonElement[] = [];
  for (const opt of themeOptions) {
    const b = element('button', 'segment-btn', opt.label);
    b.type = 'button';
    b.addEventListener('click', () => {
      applyTheme(opt.theme);
      updateThemeUi();
      updatePopoverActive();
    });
    themeCtrl.append(b);
    themeButtons.push(b);
  }
  themeSection.append(themeCtrl);

  // View filter section
  const filterSection = element('div', 'popover-section');
  filterSection.append(element('span', 'popover-label', t.viewMode));
  const filterCtrl = element('div', 'segmented-control');
  const filterOptions: { filter: ViewFilter; label: string }[] = [
    { filter: 'all', label: t.viewModeAll },
    { filter: 'chat_only', label: t.viewModeChatOnly },
  ];
  const filterButtons: HTMLButtonElement[] = [];
  for (const opt of filterOptions) {
    const b = element('button', 'segment-btn', opt.label);
    b.type = 'button';
    b.addEventListener('click', () => {
      applyFilter(opt.filter);
      updatePopoverActive();
    });
    filterCtrl.append(b);
    filterButtons.push(b);
  }
  filterSection.append(filterCtrl);

  popover.append(popHeader, fsSection, widthSection, themeSection, filterSection);

  function updatePopoverActive(): void {
    const currentTheme = getPref(PREFS.theme, 'auto');
    const currentFs = getPref(PREFS.fontSize, 'md');
    const currentWidth = getPref(PREFS.width, 'normal');
    const currentFilter = getPref(PREFS.filter, 'all');

    fsOptions.forEach((opt, idx) => {
      fsButtons[idx]!.classList.toggle('active', currentFs === opt.size);
    });
    widthOptions.forEach((opt, idx) => {
      widthButtons[idx]!.classList.toggle('active', currentWidth === opt.width);
    });
    themeOptions.forEach((opt, idx) => {
      themeButtons[idx]!.classList.toggle('active', currentTheme === opt.theme);
    });
    filterOptions.forEach((opt, idx) => {
      filterButtons[idx]!.classList.toggle('active', currentFilter === opt.filter);
    });
  }
  updatePopoverActive();

  themeToggle.addEventListener('click', () => {
    const next: Theme = isDark() ? 'light' : 'dark';
    applyTheme(next);
    updateThemeUi();
    updatePopoverActive();
  });

  readerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    popover.hidden = !popover.hidden;
  });
  popClose.addEventListener('click', () => { popover.hidden = true; });

  document.addEventListener('click', (e) => {
    if (!popover.hidden && !popover.contains(e.target as Node) && !readerBtn.contains(e.target as Node)) {
      popover.hidden = true;
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      popover.hidden = true;
    }
  });

  // 4. Download Button
  const download = element('button', 'button icon-btn', '');
  download.type = 'button';
  download.setAttribute('aria-label', t.download);
  download.title = t.download;
  const downloadIconSlot = element('span', 'btn-icon');
  downloadIconSlot.append(createIcon('download', 16));
  const downloadSr = element('span', 'sr-only', t.download);
  download.append(downloadIconSlot, downloadSr);

  // Render Timeline
  const timeline = renderTimeline(share, t);
  const allRows = [...timeline.querySelectorAll<HTMLDetailsElement>('details.timeline-row')];
  const allClampedMsgs = [...timeline.querySelectorAll<HTMLElement>('.message.user.has-clamp')];
  let updateTimer: ReturnType<typeof setTimeout> | undefined;

  function updateButtonState(): void {
    const allRowsOpen = allRows.length === 0 || allRows.every(r => r.open);
    const allMsgsOpen = allClampedMsgs.length === 0 || allClampedMsgs.every(m => !m.classList.contains('clamped'));
    const allOpen = allRowsOpen && allMsgsOpen && (allRows.length > 0 || allClampedMsgs.length > 0);
    const label = allOpen ? t.collapse : t.expand;
    expand.setAttribute('aria-expanded', String(allOpen));
    expand.setAttribute('aria-label', label);
    expand.title = label;
    expandSr.textContent = label;
    expandIconSlot.replaceChildren(createIcon(allOpen ? 'collapse' : 'expand', 16));
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
    downloadIconSlot.replaceChildren(createIcon('check', 16));
    setTimeout(() => downloadIconSlot.replaceChildren(createIcon('download', 16)), 1500);
  });

  // Floating Back to Top button
  const backToTop = element('button', 'back-to-top');
  backToTop.type = 'button';
  backToTop.setAttribute('aria-label', t.backToTop);
  backToTop.title = t.backToTop;
  backToTop.append(createIcon('arrow_up', 18), element('span', 'sr-only', t.backToTop));
  backToTop.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  let scrollTicking = false;
  window.addEventListener('scroll', () => {
    if (!scrollTicking) {
      requestAnimationFrame(() => {
        if (window.scrollY > 300) {
          backToTop.classList.add('visible');
        } else {
          backToTop.classList.remove('visible');
        }
        updateActiveDash();
        scrollTicking = false;
      });
      scrollTicking = true;
    }
  }, { passive: true });

  actions.append(expand, themeToggle, readerBtn, download);
  titleGroup.append(heading);
  inner.append(titleGroup, actions, popover);
  header.append(inner);

  app.replaceChildren(header, timeline, backToTop);
  if (sideNav) {
    app.append(sideNav);
  }
  updateActiveDash();
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
