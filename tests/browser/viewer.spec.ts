import { test, expect } from '@playwright/test';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { designShare } from '../fixtures';

const fragment = '#local-preview/00000000000000000000000000000001';
const screenshots = resolve('.local/screenshots');
const previews = ['design', 'malicious', 'claude', 'codex'];
const screenshotCases = process.env.SCREENSHOT_CASES?.split(',');
const modes = [
  { name: 'desktop-light', width: 1440, height: 1000, colorScheme: 'light' as const, locale: 'en-US' },
  { name: 'desktop-dark', width: 1440, height: 1000, colorScheme: 'dark' as const, locale: 'en-US' },
  { name: 'mobile-light', width: 390, height: 844, colorScheme: 'light' as const, locale: 'zh-CN' },
  { name: 'mobile-dark', width: 390, height: 844, colorScheme: 'dark' as const, locale: 'zh-CN' },
  { name: 'mobile-320', width: 320, height: 700, colorScheme: 'light' as const, locale: 'zh-CN' },
];

test.beforeAll(async () => {
  await mkdir(screenshots, { recursive: true });
});
for (const name of previews) for (const mode of modes) {
  test(`${name}: ${mode.name} with production CSP`, async ({ browser }) => {
    if (name === 'claude' || name === 'codex') {
      try {
        await stat(resolve('.local', `${name}.json`));
      } catch {
        test.skip(true, `No real .local/${name}.json present`);
        return;
      }
    }
    const context = await browser.newContext({ viewport: { width: mode.width, height: mode.height }, colorScheme: mode.colorScheme, locale: mode.locale });
    const page = await context.newPage();
    let consoleErrors = 0, pageErrors = 0;
    // Keep diagnostics aggregate-only: real session text never enters test output.
    page.on('console', message => { if (message.type() === 'error') consoleErrors++; });
    page.on('pageerror', () => pageErrors++);
    const response = await page.goto(`/?preview=${name}${fragment}`);
    const csp = response!.headers()['content-security-policy']!;
    for (const directive of ["script-src 'self'", "style-src 'self'", 'connect-src https://gist.githubusercontent.com', "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) expect(csp).toContain(directive);
    await expect(page.locator('.timeline')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.locator('details.timeline-row[open]').count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const screenshotName = `${name}-${mode.name}`;
    if (!screenshotCases || screenshotCases.includes(name) || screenshotCases.includes(screenshotName)) {
      await page.screenshot({ path: resolve(screenshots, `${screenshotName}.png`) });
    }
    const expand = page.getByRole('button', { name: mode.locale === 'zh-CN' ? '全部展开' : 'Expand all', exact: true });
    await expand.click();
    await expect(page.locator('details.timeline-row:not([open])')).toHaveCount(0);
    const checks = await page.evaluate(() => {
      const state = window as unknown as { __xssExecuted?: boolean; __previewChecks: { csp: string[]; errors: number } };
      return { executed: state.__xssExecuted === true, violations: state.__previewChecks.csp.length,
        inlineHandlers: document.querySelectorAll('[onerror],[onclick]').length,
        unsafeLinks: [...document.querySelectorAll('a[href]')].filter(a => !/^(https?:|mailto:)/.test(a.getAttribute('href')!)).length };
    });
    expect(checks).toEqual({ executed: false, violations: 0, inlineHandlers: 0, unsafeLinks: 0 });
    expect(consoleErrors).toBe(0); expect(pageErrors).toBe(0);
    // Tool details are complete and remain locally scrollable at phone width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // Verify no element extends beyond viewport at mobile widths unless inside horizontally scrollable container
    if (mode.width <= 390) {
      const overflowing = await page.evaluate(() => {
        const scrollableElements = new Set<Element>();
        for (const el of document.querySelectorAll('*')) {
          const style = window.getComputedStyle(el);
          if (['auto', 'scroll'].includes(style.overflowX) || ['auto', 'scroll'].includes(style.overflow)) {
            scrollableElements.add(el);
          }
        }
        const bad: string[] = [];
        const vw = window.innerWidth;
        for (const el of document.querySelectorAll('body *')) {
          let parent: Element | null = el;
          let inside = false;
          while (parent && parent !== document.body) {
            if (scrollableElements.has(parent)) { inside = true; break; }
            parent = parent.parentElement;
          }
          if (inside) continue;
          const rect = el.getBoundingClientRect();
          if (rect.right > vw + 1 || rect.left < -1) {
            bad.push(`${el.tagName}.${el.className} [left: ${rect.left}, right: ${rect.right}, vw: ${vw}]`);
          }
        }
        return bad;
      });
      expect(overflowing).toEqual([]);
    }
    if (mode.name === 'desktop-light' || mode.name === 'mobile-dark') {
      const firstTool = page.locator('details.timeline-row[data-type="tool_call"]').first();
      if (await firstTool.count()) await firstTool.locator('summary').first().evaluate(node => node.scrollIntoView({ block: 'start' }));
      const expandedName = `${screenshotName}-expanded`;
      if (!screenshotCases || screenshotCases.includes(name) || screenshotCases.includes(expandedName)) {
        await page.screenshot({ path: resolve(screenshots, `${expandedName}.png`) });
      }
    }
    await writeFile(resolve(screenshots, `${name}-${mode.name}.json`), JSON.stringify({ consoleErrors, pageErrors, ...checks }));
    await context.close();
  });
}

test('malicious content stays inert with real browser interactions; CSP blocks inline execution and styles', async ({ page }) => {
  await page.goto(`/?preview=malicious${fragment}`);
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await expect(page.locator('.markdown img')).toHaveCount(1);
  expect(await page.locator('.markdown img').evaluateAll(images => images.every(img => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
  expect(await page.locator('script:not([src]), style, iframe, object').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xssExecuted?: boolean }).__xssExecuted)).toBeUndefined();
  await page.evaluate(() => {
    const script = document.createElement('script'); script.textContent = 'window.__xssExecuted=true'; document.body.append(script);
    const style = document.createElement('style'); style.textContent = 'body{display:none}'; document.head.append(style);
    void fetch('https://example.invalid/disallowed').catch(() => {});
  });
  await expect(page.locator('.timeline')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __previewChecks: { csp: string[] } }).__previewChecks.csp.length)).toBe(3);
  expect(await page.evaluate(() => (window as unknown as { __xssExecuted?: boolean }).__xssExecuted)).toBeUndefined();
});

test('fragment payload cannot become DOM or a data request', async ({ page }) => {
  const requests: string[] = []; page.on('request', request => { if (request.url().startsWith('https://gist.')) requests.push(request.url()); });
  await page.goto('/#%3Cscript%3Ealert(1)%3C/script%3E');
  await expect(page.getByRole('status')).toContainText('invalid');
  expect(requests).toHaveLength(0); expect(await page.locator('script:not([src])').count()).toBe(0);
});

test('shows distinct invalid, deleted, oversized and retryable failure states', async ({ page }) => {
  for (const [name, text] of [['invalid', 'invalid'], ['deleted', 'deleted'], ['oversized', '10 MB'], ['failure', 'Could not load']]) {
    await page.goto(`/?preview=${name}${fragment}`);
    await expect(page.locator('.state')).toContainText(text!);
  }
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('download is complete and production has no local-file controls', async ({ page }) => {
  await page.goto(`/?preview=malicious${fragment}`);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  const event = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download', exact: true }).click();
  const download = await event, path = await download.path();
  const text = await readFile(path!, 'utf8');
  expect(text).toContain('Synthetic return result.'); expect(text).toContain('globalThis.__xssExecuted');
  expect(text).toContain('future_item<script>'); expect(text).toContain('odd\\u0000');
});

test('diff backgrounds span the entire scroll width for all lines', async ({ page }) => {
  await page.goto(`/?preview=design${fragment}`);
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  const diffs = page.locator('.diff');
  await expect(diffs.first()).toBeVisible();

  const mismatches = await page.evaluate(() => {
    const diffEls = document.querySelectorAll('.diff');
    const failures: string[] = [];
    diffEls.forEach((diffEl, idx) => {
      const scrollWidth = diffEl.scrollWidth;
      const children = Array.from(diffEl.children);
      for (let i = 0; i < children.length; i++) {
        const child = children[i] as HTMLElement;
        const childWidth = child.getBoundingClientRect().width;
        if (Math.abs(childWidth - scrollWidth) > 1.0) {
          failures.push(`diff #${idx} child #${i} (${child.className}): childWidth=${childWidth}, scrollWidth=${scrollWidth}`);
        }
      }
    });
    return failures;
  });

  expect(mismatches).toEqual([]);
});

test('benchmark: expand-all and collapse-all settle efficiently', async ({ page }) => {
  await page.goto(`/?preview=benchmark${fragment}`);
  await expect(page.locator('.timeline')).toBeVisible();

  const expandBtn = page.getByRole('button', { name: 'Expand all', exact: true });

  const startExpand = Date.now();
  await expandBtn.click();
  await expect(page.locator('details.timeline-row:not([open])')).toHaveCount(0);
  const expandDuration = Date.now() - startExpand;

  const collapseBtn = page.getByRole('button', { name: 'Collapse all', exact: true });
  const startCollapse = Date.now();
  await collapseBtn.click();
  await expect(page.locator('details.timeline-row[open]')).toHaveCount(0);
  const collapseDuration = Date.now() - startCollapse;

  console.log(`[benchmark timings] expand-all: ${expandDuration} ms, collapse-all: ${collapseDuration} ms`);
  expect(expandDuration).toBeLessThan(5000);
  expect(collapseDuration).toBeLessThan(2000);
});

test('hover swaps left icon to expand chevron without row background, and clicking toggles open', async ({ page }) => {
  await page.goto(`/?preview=design${fragment}`);
  const firstStep = page.locator('details.timeline-row.step-row').first();
  const summary = firstStep.locator('summary.row-summary');
  const kindIcon = firstStep.locator('.row-icon .icon-kind');
  const expandIcon = firstStep.locator('.row-icon .icon-expand');

  // Initially: closed, not hovered
  await expect(kindIcon).toBeVisible();
  await expect(expandIcon).toBeHidden();
  expect(await firstStep.getAttribute('open')).toBeNull();

  // Hover over the summary
  await summary.hover();
  await expect(kindIcon).toBeHidden();
  await expect(expandIcon).toBeVisible();

  // Summary background on hover must remain transparent (no gray hover highlight bar)
  const bg = await summary.evaluate(el => window.getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgba(0, 0, 0, 0)');

  // Click summary anywhere to expand
  await summary.click();
  expect(await firstStep.getAttribute('open')).not.toBeNull();
  await expect(expandIcon).toBeVisible();
  await expect(firstStep.locator('.disclosure-body')).toBeVisible();

  // Click again to collapse
  await summary.click();
  expect(await firstStep.getAttribute('open')).toBeNull();
});
