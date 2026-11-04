import { describe, expect, it, vi } from 'vitest';
import { menuPosition, visibleRange } from '../client/web';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));

describe('share menu positioning', () => {
  it('keeps the menu below when it fits, flips above near the bottom, and shifts when neither side fits', () => {
    expect(menuPosition(60, -40, 80, 0, 200)).toBe(60);
    expect(menuPosition(170, 50, 80, 0, 200)).toBe(50);
    expect(menuPosition(100, -30, 120, 0, 180)).toBe(60);
  });
  it('uses the intersection of the window and clipping ancestors', () => {
    const outer = document.createElement('div'), inner = document.createElement('div');
    document.body.append(outer); outer.append(inner);
    outer.style.overflowY = 'auto';
    vi.spyOn(outer, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
    Object.defineProperty(outer, 'clientHeight', { value: 180 });
    vi.spyOn(inner, 'getBoundingClientRect').mockReturnValue({ top: 120 } as DOMRect);
    expect(visibleRange(inner)).toEqual({ top: -20, bottom: 160 });
    outer.remove();
  });
});
