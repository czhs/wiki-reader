/**
 * The activity bar, against a real Electron process (criteria U04, U14, U15).
 *
 * The bar used to be two things wearing one row of buttons. Some of its entries opened a
 * *page* in the workspace — the wiki, the notebooks, the graph — and some opened a *column*
 * beside the reading, with its own width, its own fold-to-a-rail control and its own way of
 * being got rid of. Which of the two a button was is a fact about that surface's history and
 * about nothing the researcher is doing, and the columns are what they wrote in about: What
 * next, in particular, is a short list they wanted to be able to put down.
 *
 * So the bar is a launcher of tabs (`U15`), there is one way to put a surface away and it is
 * the one the Library button always had (`U14`), and `U04`'s promise — that opening a surface
 * never costs the reading its width — is re-anchored on the chrome that survives, which is the
 * bar itself and nothing else.
 */
import { test, expect } from './support/app.js';
import type { Page } from '@playwright/test';

/** Every surface the bar can put in front, with the button that does it. */
const SURFACES = [
  { button: 'activity-library', body: 'library-panel', panelId: 'library' },
  { button: 'activity-questions', body: 'queue-panel', panelId: 'queue' },
  { button: 'activity-annotations', body: 'annotation-list-panel', panelId: 'annotation-list' },
] as const;

const inWorkspace = (window: Page, testId: string) =>
  window.locator(`[data-testid="dockview-container"] [data-testid="${testId}"]`);

test.describe('the activity bar', () => {
  test('[U04] every surface it opens is a tab, and the reading keeps the width it had', async ({
    window,
    workspace,
  }) => {
    const [first] = workspace.pdfDocuments;
    expect(first).toBeDefined();
    if (first === undefined) return;

    // A document open, because the width being protected is the width of something being read.
    await window
      .locator(`[data-testid="library-panel"] [data-testid="library-item-${first.id}"]`)
      .click();
    const reader = window.locator(`[data-testid="pdf-reader"][data-document-id="${first.id}"]`);
    await expect(reader).toBeVisible();
    const baseline = await reader.boundingBox();
    expect(baseline).not.toBeNull();
    if (baseline === null) return;
    expect(baseline.width).toBeGreaterThan(600);

    const readerTab = window
      .locator('[data-testid="dockview-container"] .dv-tab')
      .filter({ hasText: first.title.slice(0, 20) })
      .first();

    // The two launchers, in turn. Each takes the pane it is asked for and hands it back: the
    // reader is the width it was, exactly, because nothing was drawn beside it. Under the old
    // arrangement each of these was a 280px column and the reader paid for every one.
    for (const surface of ['activity-library', 'activity-questions'] as const) {
      await window.locator(`[data-testid="${surface}"]`).click();
      // Nothing anywhere in the window is a column beside the work any more.
      await expect(window.locator('.wr-sidebar')).toHaveCount(0);

      await readerTab.click();
      await expect(reader).toBeVisible();
      const box = await reader.boundingBox();
      expect(box, `the reader vanished after ${surface}`).not.toBeNull();
      if (box === null) continue;
      expect(box.width, `${surface} narrowed the reader`).toBeCloseTo(baseline.width, 0);
    }
  });

  test('[U15] What next opens as a tab, and so does every other surface the bar names', async ({
    window,
    workspace,
  }) => {
    const [paper] = workspace.pdfDocuments;
    expect(paper).toBeDefined();
    if (paper === undefined) return;

    // The app opens on the library, and it is already a tab: inside the Dockview container,
    // with a tab of its own in the strip.
    await expect(inWorkspace(window, 'library-panel')).toBeVisible();
    await expect(
      window.locator('[data-testid="dockview-container"] .dv-tab[data-panel-id="library"]'),
    ).toHaveCount(1);

    await window
      .locator(`[data-testid="library-panel"] [data-testid="library-item-${paper.id}"]`)
      .click();
    await expect(
      window.locator(`[data-testid="pdf-reader"][data-document-id="${paper.id}"]`),
    ).toBeVisible();

    // What next is the one the researcher wrote about, and the one that had no panel kind at
    // all: it existed only as the left slot's second occupant.
    await window.locator('[data-testid="activity-questions"]').click();
    await expect(inWorkspace(window, 'queue-panel')).toBeVisible();
    const queueTab = window.locator(
      '[data-testid="dockview-container"] .dv-tab[data-panel-id="queue"]',
    );
    await expect(queueTab).toHaveCount(1);
    await expect(queueTab).toContainText('What next');

    // The annotations list, which was the right-hand column.
    await window.locator('[data-testid="activity-annotations"]').click();
    await expect(inWorkspace(window, 'annotation-list-panel')).toBeVisible();
    await expect(
      window.locator('[data-testid="dockview-container"] .dv-tab[data-panel-id="annotation-list"]'),
    ).toHaveCount(1);

    // And the references, which were a strip beneath the whole workspace.
    await window.keyboard.press('Shift+F12');
    await expect(inWorkspace(window, 'references-panel')).toBeVisible();
    await expect(
      window.locator('[data-testid="dockview-container"] .dv-tab[data-panel-id="references"]'),
    ).toHaveCount(1);

    // Which is the whole claim: there is no side panel left in the app.
    await expect(window.locator('.wr-sidebar')).toHaveCount(0);
    await expect(window.locator('[data-testid="bottom-panel"]')).toHaveCount(0);
  });

  test('[U14] there is one kind of minimize — the button that opened a surface puts it away', async ({
    window,
  }) => {
    // The fold-to-a-rail control is gone, everywhere. It was the second kind: it left the
    // panel open and its button lit, so the same word meant two different states.
    await expect(window.locator('[data-control="shell.minimize"]')).toHaveCount(0);
    await expect(window.locator('[data-testid^="minimize-"]')).toHaveCount(0);

    for (const surface of SURFACES) {
      const button = window.locator(`[data-testid="${surface.button}"]`);
      const body = window.locator(`[data-testid="${surface.body}"]`);

      // Start from away, whichever state the surface happens to be in — the library is what
      // the app opens on, the other two are not.
      if (await body.isVisible()) await button.click();
      await expect(body, `${surface.body} would not go away`).toHaveCount(0);
      await expect(button).toHaveAttribute('aria-pressed', 'false');

      // Press: it is here, and the bar says so.
      await button.click();
      await expect(body, `${surface.body} did not open`).toBeVisible();
      await expect(button).toHaveAttribute('aria-pressed', 'true');

      // Press again: it is gone — not folded to a rail, not still open behind a glyph — and
      // the bar agrees. The same gesture and the same outcome for all three.
      await button.click();
      await expect(body).toHaveCount(0);
      await expect(button).toHaveAttribute('aria-pressed', 'false');
      await expect(
        window.locator(`.dv-tab[data-panel-id="${surface.panelId}"]`),
        `${surface.panelId} left a tab behind`,
      ).toHaveCount(0);
    }
  });
});

test.describe('controls that cannot act yet', () => {
  test('[U05] the graph button says what it needs when nothing is selected', async ({ window }) => {
    // A fresh workspace: the library is listed, but nothing is open, so there is no entity
    // for the graph to be a graph *of*. The button is enabled — pressing it is a reasonable
    // thing to do — and it used to report `no entity to act on`, which is true and tells a
    // reader nothing about what would work instead.
    await expect(window.locator('[data-testid="library-panel"]')).toBeVisible();
    await window.locator('[data-testid="activity-graph"]').click();

    const status = window.locator('[data-testid="status-message"]');
    await expect(status).toBeVisible();
    // Names the two things that would seed it, in the words the UI uses for them.
    await expect(status).toContainText('Open a document or select a highlight');
    await expect(status).not.toContainText('no entity to act on');

    // And it is genuinely an explanation, not a graph that failed to draw: no panel opened.
    await expect(window.locator('[data-testid="graph-panel"]')).toHaveCount(0);
  });

  test('[U07] a disabled control names its precondition, beside the control', async ({
    window,
  }) => {
    // The librarian is off on a fresh library, which is what disables "Run a pass now". It
    // comes up over the workspace from the wiki now, rather than in a sidebar (`F07`).
    const popup = window.locator('[data-testid="librarian-popup"]');
    await expect(async () => {
      if (!(await popup.isVisible())) {
        await window.locator('[data-testid="activity-wiki"]').click();
        await window.locator('[data-testid="wiki-librarian"]').click();
      }
      await expect(popup).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    const run = window.locator('[data-testid="agent-run"]');
    await expect(run).toBeDisabled();

    // The reason is on screen, in text, without hovering anything. `toBeVisible` is the point
    // of the criterion: a `title` attribute would satisfy "the app knows why" and still leave
    // the person looking at a grey button with no explanation.
    const reason = window.locator('[data-testid="agent-run-blocked"]');
    await expect(reason).toBeVisible();
    await expect(reason).toContainText('Turn the librarian on');

    // "Where it is disabled" — the explanation sits with the button, not in a status bar at
    // the other end of the window or in a panel you would have to go and find.
    const runBox = await run.boundingBox();
    const reasonBox = await reason.boundingBox();
    expect(runBox).not.toBeNull();
    expect(reasonBox).not.toBeNull();
    if (runBox === null || reasonBox === null) return;
    expect(Math.abs(reasonBox.y - (runBox.y + runBox.height))).toBeLessThan(60);

    // And it goes away when it stops being true, rather than becoming a permanent label that
    // contradicts an enabled button.
    await window.locator('[data-testid="agent-enable"]').click();
    await expect(run).toBeEnabled();
    await expect(reason).toHaveCount(0);
  });
});
