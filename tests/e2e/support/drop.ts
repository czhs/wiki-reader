/**
 * Dropping a real file on the running application.
 *
 * The `File` has to come from the operating system, because the mechanism under test is
 * `webUtils.getPathForFile` in the preload — a `File` built in JavaScript has no path and must
 * not acquire one. A file input is how Playwright hands the browser a real one; its `File` is
 * then moved into a `DataTransfer` and dispatched at the target, which is the same object a
 * hand's drop would deliver.
 *
 * Shared because three criteria drop a file at three different targets (`N07` at a desk board,
 * `B02` at the library, `G04` at the library again on the way to a node's icon) and the
 * sequence is the mechanism, not the criterion: a copy per spec is three places for it to
 * drift from what the preload actually listens for.
 */
import type { Page } from '@playwright/test';

const SOURCE_ID = 'e2e-drop-source';

export async function dropFileOn(window: Page, selector: string, path: string): Promise<void> {
  await window.evaluate((id) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = id;
    input.style.display = 'none';
    document.body.append(input);
  }, SOURCE_ID);
  await window.setInputFiles(`#${SOURCE_ID}`, path);

  const transfer = await window.evaluateHandle((id) => {
    const input = document.querySelector(`#${id}`);
    const data = new DataTransfer();
    if (input instanceof HTMLInputElement && input.files !== null) {
      for (const file of Array.from(input.files)) data.items.add(file);
    }
    return data;
  }, SOURCE_ID);
  await window.locator(selector).dispatchEvent('drop', { dataTransfer: transfer });

  await window.evaluate((id) => {
    document.querySelector(`#${id}`)?.remove();
  }, SOURCE_ID);
}
