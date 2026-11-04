import { Platform } from 'react-native';

/** Visible vertical range of a web view after clipping by its scrollable ancestors. */
export function visibleRange(view: unknown): { top: number; bottom: number } | undefined {
  if (Platform.OS !== 'web' || !view) return undefined;
  type Rect = { top: number; bottom: number };
  type Element = { parentElement: Element | null; getBoundingClientRect(): Rect; clientHeight: number; clientTop: number };
  const element = view as Element;
  const browser = globalThis as unknown as { innerHeight: number; getComputedStyle(element: Element): { overflowY: string } };
  const rect = element.getBoundingClientRect();
  let top = 0, bottom = browser.innerHeight;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (!['auto', 'scroll', 'hidden', 'clip'].includes(browser.getComputedStyle(parent).overflowY)) continue;
    const bounds = parent.getBoundingClientRect();
    const start = bounds.top + parent.clientTop;
    top = Math.max(top, start);
    bottom = Math.min(bottom, start + parent.clientHeight);
  }
  return { top: top - rect.top, bottom: bottom - rect.top };
}
