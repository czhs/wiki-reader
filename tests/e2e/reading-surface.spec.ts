/**
 * The reading surface, judged the way a reader judges it.
 *
 * The rest of the E2E suite asserts that text is *present* — `innerText`, element counts,
 * anchors that resolve. All of that passes on a document rendered in light grey on cream,
 * which is what shipped: `--wr-surface` was never defined, so the markdown reader fell back
 * to a paper-coloured literal while `--wr-text` resolved to the dark chrome's light grey.
 * Contrast was 1.34:1 and every test was green.
 *
 * So these assert what those could not: that a reading surface is legible, and that
 * annotating one does not move it out from under the reader.
 */
import { test, expect } from './support/app.js';
import type { Page } from '@playwright/test';

/** WCAG 2.1 contrast, computed in the page against the real composited colours. */
const CONTRAST_HELPERS = `
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const parse = (c) => {
    const m = c.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [255, 255, 255];
  };
  // Walk up for the first non-transparent background, the way the compositor does.
  const backdrop = (el) => {
    let node = el;
    while (node) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(bg)) return bg;
      node = node.parentElement;
    }
    return 'rgb(255, 255, 255)';
  };
  const contrast = (el) => {
    const a = lum(parse(getComputedStyle(el).color));
    const b = lum(parse(backdrop(el)));
    const hi = Math.max(a, b), lo = Math.min(a, b);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };
`;

/** The worst contrast among the elements that actually carry body text. */
async function worstContrast(window: Page, root: string): Promise<{ ratio: number; sample: string }> {
  return window.evaluate(`(() => {
    ${CONTRAST_HELPERS}
    const scope = document.querySelector(${JSON.stringify(root)});
    if (!scope) throw new Error('no ' + ${JSON.stringify(root)});
    const carriers = [...scope.querySelectorAll('h1, h2, h3, h4, p, li, td, blockquote, code, a, button')]
      .filter((el) => (el.textContent ?? '').trim().length > 0)
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    if (carriers.length === 0) throw new Error('no text carriers in ' + ${JSON.stringify(root)});
    let worst = { ratio: Infinity, sample: '' };
    for (const el of carriers) {
      const ratio = contrast(el);
      if (ratio < worst.ratio) {
        worst = { ratio, sample: el.tagName + ': ' + (el.textContent ?? '').trim().slice(0, 60) };
      }
    }
    return worst;
  })()`);
}

test('[UX01] the markdown reading surface meets WCAG AA contrast', async ({ window, workspace }) => {
  await window
    .locator('[data-testid^="library-item-"]', { hasText: workspace.corpusPage.title })
    .first()
    .click();
  await window.waitForSelector('.wr-markdown__body', { timeout: 60_000 });
  await window.waitForTimeout(500);

  const worst = await worstContrast(window, '.wr-markdown');
  expect(
    worst.ratio,
    `lowest-contrast text on the markdown surface was ${String(worst.ratio)}:1 — ${worst.sample}`,
  ).toBeGreaterThanOrEqual(4.5);
});

test('[UX02] every reading-surface token the stylesheets use is actually defined', async ({
  window,
}) => {
  // The bug was a *silently* undefined custom property: `var(--wr-surface, #fbfaf7)` renders
  // fine, just with the wrong half of the palette. Nothing fails, so nothing catches it.
  const undefinedVars = await window.evaluate(() => {
    const used = new Set<string>();
    for (const sheet of [...document.styleSheets]) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of [...rules]) {
        for (const match of rule.cssText.matchAll(/var\(\s*(--wr-[a-z0-9-]+)/g)) {
          used.add(match[1]!);
        }
      }
    }
    const root = getComputedStyle(document.documentElement);
    return [...used].filter((name) => root.getPropertyValue(name).trim() === '').sort();
  });

  expect(
    undefinedVars,
    `these custom properties are used by a stylesheet but never defined, so every use silently falls back: ${undefinedVars.join(', ')}`,
  ).toEqual([]);
});

test('[UX03] creating a highlight does not move the document under the reader', async ({
  window,
  workspace,
}) => {
  await window.locator(`[data-testid="library-item-${workspace.pdfDocuments[0]!.id}"]`).click();
  await window.waitForSelector('[data-testid="pdf-page-0"][data-rendered="true"]', {
    timeout: 60_000,
  });
  await window.waitForTimeout(1000);

  const geometry = () =>
    window.evaluate(() => {
      const scroll = document.querySelector('[data-testid="pdf-scroll"]') as HTMLElement;
      const page = document.querySelector('[data-testid="pdf-page-0"]') as HTMLElement;
      return {
        readerWidth: Math.round(scroll.getBoundingClientRect().width),
        viewportHeight: Math.round(scroll.clientHeight),
        pageTop: Math.round(page.getBoundingClientRect().top),
        pageLeft: Math.round(page.getBoundingClientRect().left),
      };
    });

  const before = await geometry();

  await window.evaluate(() => {
    const spans = [...document.querySelectorAll('.wr-pdf-page__text-layer span')]
      .filter((s) => (s.textContent ?? '').trim().length > 3)
      .slice(0, 4);
    const range = document.createRange();
    range.setStart(spans[0]!.firstChild ?? spans[0]!, 0);
    const last = spans[spans.length - 1]!;
    range.setEnd(last.firstChild ?? last, (last.textContent ?? '').length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document
      .querySelector('[data-testid="pdf-scroll"]')!
      .dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await window.waitForSelector('[data-testid="create-highlight"]', { timeout: 10_000 });
  await window.waitForTimeout(300);

  // Showing the selection affordance must not resize the page being read.
  const selecting = await geometry();
  expect(selecting, 'the selection toolbar resized the reader').toEqual(before);

  await window.locator('[data-testid="create-highlight"]').click();
  await window.waitForSelector('[data-testid^="pdf-highlight-"]', { timeout: 30_000 });
  await window.waitForTimeout(1000);

  const after = await geometry();
  expect(after, 'committing a highlight moved or resized the document').toEqual(before);
});
