/**
 * Driving a saved web page's archive frame from the outside.
 *
 * The frame is a sandboxed nested browsing context: its events never cross into the app's
 * document, and the only way a selection inside it reaches the main process is Chromium's own
 * context-menu report (`H01`). So a spec that wants to mark a sentence on a saved page has to
 * do exactly what a hand does — put a real DOM Range inside the frame, then right-click on the
 * selected words with a real mouse.
 *
 * The point is the part that gets written wrong. The reader lays the frame out at desktop
 * width and scales it down to fit the panel, and Playwright's hit-testing does not know that,
 * so `locator.click` lands on `<body>` and Chromium drops the gesture. The scale the panel
 * publishes as `data-snapshot-scale` is the only honest way in, and computing it was written
 * out twice before this file existed.
 */
import { expect, type FrameLocator, type Page } from '@playwright/test';

/** Where a selection was made inside the frame, in the frame's own coordinates. */
export interface FrameSelection {
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

/** Select a paragraph inside the archive, in the frame's own document. */
export async function selectInFrame(frame: FrameLocator): Promise<FrameSelection> {
  const paragraph = frame.locator('p').first();
  await expect(paragraph).toBeVisible({ timeout: 30_000 });

  const inside = await paragraph.evaluate((element) => {
    const view = element.ownerDocument.defaultView;
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    const selection = view?.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const box = element.getBoundingClientRect();
    return { text: selection?.toString() ?? '', x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  expect(inside.text.trim().length).toBeGreaterThan(12);
  return inside;
}

/**
 * Right-click a point in the frame's coordinates, through the scale the reader published.
 *
 * `reader` is the `html-reader` panel that owns the frame — the scale is its attribute, and a
 * spec that read it off a second copy would be asserting about a page it is not driving.
 */
export async function rightClickInFrame(
  window: Page,
  reader: { getAttribute: (name: string) => Promise<string | null> },
  at: { readonly x: number; readonly y: number },
): Promise<void> {
  const frameBox = await window.locator('[data-testid="snapshot-frame"]').boundingBox();
  const scale = Number(await reader.getAttribute('data-snapshot-scale'));
  if (frameBox === null || !Number.isFinite(scale)) throw new Error('the snapshot is not on screen');
  await window.mouse.click(frameBox.x + at.x * scale, frameBox.y + at.y * scale, {
    button: 'right',
  });
}

/**
 * Select a paragraph of the archived page and ask for its context menu, the way a reader does.
 *
 * Nothing here reaches into the app: the only thing arranged is the state a person's hand
 * would leave behind. Answers with the words that were selected.
 */
export async function selectAndInvoke(
  window: Page,
  documentId: string,
  frame: FrameLocator,
): Promise<string> {
  const inside = await selectInFrame(frame);
  await rightClickInFrame(
    window,
    window.locator(`[data-testid="html-reader"][data-document-id="${documentId}"]`),
    inside,
  );
  return inside.text;
}
