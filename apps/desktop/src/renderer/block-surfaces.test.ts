/**
 * Which writing surface a bare command lands on (`R01`, `P12`).
 *
 * The registry is a module with no React in it precisely so that this can be driven directly:
 * the failure it exists to prevent is a command that has a surface to act on and cannot find
 * it, which on screen reads as `Cmd+S` doing nothing to a page that is plainly open.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  blockSurface,
  registerBlockSurface,
  touchBlockSurface,
  type BlockSurface,
} from './block-surfaces.js';

function surfaceStub(): BlockSurface {
  return {
    open: () => undefined,
    insertAfter: () => undefined,
    save: () => undefined,
    remove: () => undefined,
  };
}

describe('the writing surface in hand', () => {
  const disposers: Array<() => void> = [];

  function mount(surfaceId: string): { surface: BlockSurface; unmount: () => void } {
    const surface = surfaceStub();
    const dispose = registerBlockSurface(surfaceId, surface);
    disposers.push(dispose);
    return { surface, unmount: dispose };
  }

  beforeEach(() => {
    while (disposers.length > 0) disposers.pop()?.();
  });

  it('[P12] hands a bare command the surface that mounted last', () => {
    const page = mount('notebook:qst_1');
    expect(blockSurface(null)).toBe(page.surface);

    const journal = mount('journal:qst_1:2026-08-01');
    expect(blockSurface(null)).toBe(journal.surface);
  });

  /**
   * `P09`'s own workflow: a notebook page open, the journal popped up over it, the pop-up
   * closed. The page never re-registers — its handle and its surfaceId are both stable — so a
   * hand that fell to null stayed null, and `Cmd+S` answered "open a notebook page or a
   * journal day first" over the open page it was pressed on.
   */
  it('[P12] gives the hand back to the page still open when a pop-up over it closes', () => {
    const page = mount('notebook:qst_1');
    const journal = mount('journal:qst_1:2026-08-01');

    journal.unmount();

    expect(blockSurface(null)).toBe(page.surface);
  });

  it('[P12] falls back to the one most recently written in, not the one that mounted first', () => {
    const first = mount('notebook:qst_1');
    mount('notebook:qst_2');
    const popup = mount('journal:qst_1:2026-08-01');
    // Back to the first page, which is where the researcher was typing.
    touchBlockSurface('notebook:qst_1');
    // …and only then the pop-up takes the hand and gives it back.
    touchBlockSurface('journal:qst_1:2026-08-01');

    popup.unmount();

    expect(blockSurface(null)).toBe(first.surface);
  });

  it('[P12] answers null only when nothing is mounted at all', () => {
    const page = mount('notebook:qst_1');
    page.unmount();
    expect(blockSurface(null)).toBeNull();
  });

  it('[P12] still answers a command that named its own surface', () => {
    const page = mount('notebook:qst_1');
    const journal = mount('journal:qst_1:2026-08-01');
    expect(blockSurface('notebook:qst_1')).toBe(page.surface);
    expect(blockSurface('journal:qst_1:2026-08-01')).toBe(journal.surface);
    expect(blockSurface('notebook:qst_9')).toBeNull();
  });
});
