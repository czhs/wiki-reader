/**
 * WCAG contrast, measured on the colours the compositor actually used.
 *
 * The bug this exists for is the one where every other assertion passes: text is in the DOM,
 * has a colour and has a size — and is 1.3:1 against what is behind it. The chrome's ink is
 * chosen for the chrome's near-black; put it on a paper-coloured surface (a reading view, or a
 * chip painted in a highlight's own colour) and it is present and invisible.
 *
 * The page is asked only what it painted — two colour strings per element, which is a DOM
 * question — and the arithmetic is done here, in one place and one language. Two specs need it.
 */
import type { Locator, Page } from '@playwright/test';

/** What an element is painted in: its own ink, and the first opaque thing behind it. */
export interface PaintedText {
  readonly color: string;
  readonly backdrop: string;
  readonly sample: string;
}

/** Read `rgb(…)` / `rgba(…)` as three channels; anything unparseable is treated as white. */
function channels(colour: string): readonly [number, number, number] {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(colour);
  if (match === null) return [255, 255, 255];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function luminance(colour: string): number {
  const [r, g, b] = channels(colour).map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio, to two decimal places. */
export function contrastRatio(painted: PaintedText): number {
  const ink = luminance(painted.color);
  const behind = luminance(painted.backdrop);
  const hi = Math.max(ink, behind);
  const lo = Math.min(ink, behind);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/**
 * The half that has to run in the page: each element's ink, and the first non-transparent
 * background above it — which is what the compositor puts underneath it.
 *
 * Passed by reference to `evaluateAll`, so this is the only copy and both callers get it.
 */
const readPaint = (elements: readonly Element[]): PaintedText[] =>
  elements
    .filter((element) => (element.textContent ?? '').trim().length > 0)
    .filter((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    })
    .map((element) => {
      const view = element.ownerDocument.defaultView;
      let node: Element | null = element;
      let backdrop = 'rgb(255, 255, 255)';
      while (node !== null) {
        const background = view?.getComputedStyle(node).backgroundColor ?? '';
        if (background !== '' && !/rgba\(0, 0, 0, 0\)|transparent/.test(background)) {
          backdrop = background;
          break;
        }
        node = node.parentElement;
      }
      return {
        color: view?.getComputedStyle(element).color ?? '',
        backdrop,
        sample: `${element.tagName}: ${(element.textContent ?? '').trim().slice(0, 60)}`,
      };
    });

/** How legible one element's own text is on whatever is behind it. */
export async function contrastOf(target: Locator): Promise<number> {
  const [painted] = await target.evaluateAll(readPaint);
  if (painted === undefined) throw new Error('nothing to measure: the element carries no text');
  return contrastRatio(painted);
}

/** The worst contrast among the elements inside `root` that actually carry text. */
export async function worstContrast(
  window: Page,
  root: string,
): Promise<{ ratio: number; sample: string }> {
  const painted = await window
    .locator(root)
    .locator('h1, h2, h3, h4, p, li, td, blockquote, code, a, button')
    .evaluateAll(readPaint);
  if (painted.length === 0) throw new Error(`no text carriers in ${root}`);

  let worst = { ratio: Number.POSITIVE_INFINITY, sample: '' };
  for (const one of painted) {
    const ratio = contrastRatio(one);
    if (ratio < worst.ratio) worst = { ratio, sample: one.sample };
  }
  return worst;
}
