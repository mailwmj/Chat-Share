import { turnCountText, type Translations } from './i18n';
import { element } from './render';

function flatten(prose: HTMLElement, t: Translations): string {
  const copy = prose.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('.code-block-header, pre, table, img').forEach(node => node.remove());
  copy.querySelectorAll('br').forEach(br => br.replaceWith(' '));
  // Image placeholders are noise in a preview; the full message is one click away.
  return copy.textContent!.split(t.image).join(' ').replace(/\s+/g, ' ').trim();
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

/** The first reply of a turn is the one that answers the question; later ones usually report tool progress. */
function firstReply(message: HTMLElement, t: Translations): string {
  for (let node = message.nextElementSibling; node; node = node.nextElementSibling) {
    if (!(node instanceof HTMLElement) || !node.classList.contains('message')) continue;
    if (node.classList.contains('user')) break;
    const prose = node.querySelector<HTMLElement>('.markdown');
    const text = prose ? flatten(prose, t) : '';
    if (text) return clip(text, 240);
  }
  return '';
}

/** 24-hour local clock, independent of the reader's locale so the footer stays aligned. */
function clock(timestamp: string | undefined): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function createOutline(timeline: HTMLElement, toolbar: HTMLElement, t: Translations) {
  const messages = [...timeline.querySelectorAll<HTMLElement>('.message.user')];
  if (!messages.length) return;

  const nav = element('nav', 'side-outline-nav');
  nav.setAttribute('aria-label', t.tableOfContents);
  const list = element('div', 'side-outline-list');
  const preview = element('div', 'side-dash-bubble');
  preview.id = 'outline-preview';
  preview.setAttribute('popover', 'manual');
  preview.setAttribute('role', 'tooltip');
  const previewTitle = element('div', 'side-dash-title');
  const previewText = element('div', 'side-dash-body');
  const previewMeta = element('div', 'side-dash-meta');
  const previewPosition = element('span', 'side-dash-position');
  const previewTime = element('time', 'side-dash-time');
  previewMeta.append(previewPosition, previewTime);
  preview.append(previewTitle, previewText, previewMeta);
  nav.append(list, preview);

  const turns = messages.map(message => {
    const title = flatten(message.querySelector<HTMLElement>('.markdown')!, t) || t.untitled;
    const stamp = message.dataset.timestamp ?? '';
    return {
      title: clip(title, 160),
      reply: firstReply(message, t),
      stamp,
      time: clock(stamp),
    };
  });

  const events = new AbortController();
  const { signal } = events;
  const pointer = matchMedia('(hover: hover) and (pointer: fine)');
  let activeIndex = -1;
  let previewIndex: number | undefined;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;

  function revealActive(): void {
    const button = buttons[activeIndex];
    if (!button || previewIndex !== undefined || nav.matches(':hover') || getComputedStyle(preview).display !== 'none') return;
    if (button.offsetTop < list.scrollTop || button.offsetTop + button.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = button.offsetTop - (list.clientHeight - button.offsetHeight) / 2;
    }
  }

  function closePreview(): void {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    if (previewIndex !== undefined) {
      buttons[previewIndex]!.classList.remove('is-previewed');
      buttons[previewIndex]!.removeAttribute('aria-describedby');
    }
    previewIndex = undefined;
    preview.hidePopover();
    revealActive();
  }

  function showPreview(index: number, keyboard = false): void {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    // The marker reacts immediately; only the first text preview waits to avoid accidental popups.
    if (previewIndex !== undefined) {
      buttons[previewIndex]!.classList.remove('is-previewed');
      buttons[previewIndex]!.removeAttribute('aria-describedby');
    }
    previewIndex = index;
    nav.dataset.previewInput = keyboard ? 'keyboard' : 'pointer';
    const button = buttons[index]!;
    button.classList.add('is-previewed');
    const show = () => {
      const alreadyOpen = preview.matches(':popover-open');
      const turn = turns[index]!;
      previewTitle.textContent = turn.title;
      previewText.textContent = turn.reply;
      previewText.hidden = !turn.reply;
      previewPosition.textContent = turnCountText(index + 1, turns.length, t.locale);
      previewTime.textContent = turn.time;
      previewTime.hidden = !turn.time;
      previewTime.setAttribute('datetime', turn.stamp);
      preview.classList.toggle('instant', keyboard || alreadyOpen);
      // Keep the last anchor during the exit fade so the preview cannot jump to the window corner.
      list.querySelector('.preview-anchor')?.classList.remove('preview-anchor');
      button.classList.add('preview-anchor');
      button.setAttribute('aria-describedby', preview.id);
      if (!alreadyOpen) preview.showPopover();
    };
    if (keyboard || preview.matches(':popover-open')) show();
    else openTimer = setTimeout(show, 120);
  }

  function scheduleClose(): void {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    closeTimer = setTimeout(closePreview, 120);
  }

  const buttons = messages.map((message, index) => {
    const button = element('button', 'side-dash-item');
    button.type = 'button';
    button.dataset.entryIndex = message.dataset.entryIndex;
    button.setAttribute('aria-label', `${t.you} ${index + 1}: ${turns[index]!.title}`);
    const bar = element('span', 'side-dash-bar');
    bar.setAttribute('aria-hidden', 'true');
    button.append(bar);
    button.addEventListener('pointerenter', () => {
      if (pointer.matches) showPreview(index);
    });
    button.addEventListener('focus', () => {
      if (button.matches(':focus-visible')) showPreview(index, true);
    });
    button.addEventListener('click', () => {
      closePreview();
      message.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
      message.classList.remove('highlight-target');
      void message.offsetWidth;
      message.classList.add('highlight-target');
    });
    message.addEventListener('animationend', () => message.classList.remove('highlight-target'), { signal });
    list.append(button);
    return button;
  });

  nav.addEventListener('pointerleave', scheduleClose);
  preview.addEventListener('pointerenter', () => clearTimeout(closeTimer));
  preview.addEventListener('pointerleave', scheduleClose);
  preview.addEventListener('transitionend', revealActive);
  nav.addEventListener('focusout', event => {
    if (!nav.contains(event.relatedTarget as Node | null)) closePreview();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closePreview();
  }, { signal });

  function updateActive(): void {
    const readingTop = toolbar.getBoundingClientRect().bottom + 32;
    let next = 0;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]!.getBoundingClientRect().top <= readingTop) next = i;
      else break;
    }
    if (window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) next = messages.length - 1;
    if (next === activeIndex) return;
    if (activeIndex >= 0) {
      buttons[activeIndex]!.classList.remove('active');
      buttons[activeIndex]!.removeAttribute('aria-current');
    }
    activeIndex = next;
    buttons[next]!.classList.add('active');
    buttons[next]!.setAttribute('aria-current', 'location');
    revealActive();
  }

  function scheduleUpdate(): void {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      updateActive();
    });
  }

  window.addEventListener('scroll', scheduleUpdate, { passive: true, signal });
  window.addEventListener('resize', () => { closePreview(); scheduleUpdate(); }, { signal });
  const resize = new ResizeObserver(scheduleUpdate);
  resize.observe(timeline);
  resize.observe(toolbar);
  scheduleUpdate();

  return {
    nav,
    dispose() {
      closePreview();
      events.abort();
      resize.disconnect();
      cancelAnimationFrame(frame);
    },
  };
}
