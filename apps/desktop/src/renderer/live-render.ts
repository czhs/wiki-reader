/**
 * Where the live render goes (criterion S07).
 *
 * The rule is the **panel's aspect**, not the window's and not a breakpoint: a notebook tab
 * taking the full width of the workspace has room beside the writing, one taking the full
 * height has room beneath it, and one sharing the split with something else has room for
 * neither and gets no render at all. Which is the honest answer — a typeset page squeezed into
 * a third of a half-width panel is not a preview of anything.
 *
 * A pure function of two numbers so the thresholds are settled in one place and testable
 * without a DOM. The panel measures itself with a `ResizeObserver`, the way `graph-canvas.tsx`
 * does; a media query would be answering a question about the window instead.
 */
import type { TypstStackedPlacement } from '@wr/shared-types';

export type LiveRenderPlacement = 'right' | 'below' | 'above' | 'none';

/**
 * Wider than this many times its height and the panel is *full-width* — it is lying along the
 * top or bottom of the workspace, or it is the only thing open. Taller by the same factor and
 * it is full-height. Between the two it is sharing, and shares badly.
 *
 * 1.4 rather than 1: a panel a few pixels wider than it is tall is a square, and a render that
 * appeared and disappeared as a splitter wobbled would be worse than no render.
 */
const ASPECT = 1.4;

/** Narrower than this and the render would be a smudge whichever side it went. */
const MIN_EDGE = 320;

export function liveRenderPlacement(
  width: number,
  height: number,
  stacked: TypstStackedPlacement,
): LiveRenderPlacement {
  if (width < MIN_EDGE || height < MIN_EDGE) return 'none';
  if (width >= height * ASPECT) return 'right';
  if (height >= width * ASPECT) {
    // The one case the researcher gets a say in: beneath the writing by default, above it if
    // that is where they want to watch it, or off. Off is a real answer — someone drafting
    // does not always want the typeset page in the corner of their eye.
    return stacked === 'off' ? 'none' : stacked === 'top' ? 'above' : 'below';
  }
  return 'none';
}
