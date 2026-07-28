/**
 * The left sidebar slot, against a real Electron process (criterion U04).
 *
 * The four left sidebars shipped as independent booleans rendered as siblings, so opening all
 * four left 252px of a 1440px window for the document. Every existing assertion about the
 * activity bar was about *clicking* it — whether a sidebar appeared — and none about what
 * appearing cost the reader. So this test measures.
 *
 * The unit half, on the state rule itself, is in `packages/workbench/test/layout.test.ts`.
 * This half is what a person actually experiences: pixels on screen after four clicks.
 */
import { test, expect } from './support/app.js';
import type { Page } from '@playwright/test';

/** Every left sidebar on screen. The criterion is that this is never more than one. */
const leftSidebars = (window: Page) => window.locator('.wr-sidebar--left');

/**
 * The four, starting from the one the app does *not* launch showing.
 *
 * Order matters: the library is open on a fresh workspace, so leading with it would press its
 * own button and close it — the toggle behaviour, correct but not what this test is measuring.
 * Every click below is a genuine switch from one sidebar to another, ending back at the
 * library so the cycle closes.
 */
const ACTIVITY = [
  { testId: 'activity-questions', sidebar: 'questions-sidebar' },
  { testId: 'activity-journal', sidebar: 'journal-sidebar' },
  { testId: 'activity-librarian', sidebar: 'librarian-sidebar' },
  { testId: 'activity-library', sidebar: 'library-sidebar' },
] as const;

test.describe('the left sidebar', () => {
  test('[U04] replaces the open sidebar rather than stacking, so the reader keeps its width', async ({
    window,
    workspace,
  }) => {
    const [first] = workspace.pdfDocuments;
    expect(first).toBeDefined();
    if (first === undefined) return;

    // A document open, because the width being protected is the width of something being read.
    await window
      .locator(`[data-testid="library-sidebar"] [data-testid="library-item-${first.id}"]`)
      .click();
    const reader = window.locator(`[data-testid="pdf-reader"][data-document-id="${first.id}"]`);
    await expect(reader).toBeVisible();

    // The baseline is one sidebar open — the state the app launches in — not zero. What the
    // criterion promises is that the second, third and fourth sidebar cost nothing, so the
    // honest comparison is against the first one already being there.
    await expect(leftSidebars(window)).toHaveCount(1);
    const baseline = await reader.boundingBox();
    expect(baseline).not.toBeNull();
    if (baseline === null) return;
    expect(baseline.width).toBeGreaterThan(0);

    for (const { testId, sidebar } of ACTIVITY) {
      await window.locator(`[data-testid="${testId}"]`).click();

      // The one that was open is gone; this one is here. Asserting the count is what catches
      // stacking — asserting only that the new sidebar is visible passes either way.
      await expect(window.locator(`[data-testid="${sidebar}"]`)).toBeVisible();
      await expect(leftSidebars(window)).toHaveCount(1);

      const box = await reader.boundingBox();
      expect(box, `reader vanished after opening ${sidebar}`).not.toBeNull();
      if (box === null) continue;
      // Exactly its width back, not merely "still wide": the sidebars are the same width as
      // each other, so a swap costs the reader nothing at all. The old behaviour lost ~200px
      // per sidebar and would fail here on the very first swap.
      expect(box.width, `${sidebar} narrowed the reader`).toBeCloseTo(baseline.width, 0);
    }

    // All four have now been opened in turn. Under the old arrangement this is the 252px
    // window: four asides side by side and a sliver of document. Under one slot it is the
    // same reader it was before the first click.
    const afterAll = await reader.boundingBox();
    expect(afterAll).not.toBeNull();
    if (afterAll === null) return;
    expect(afterAll.width).toBeCloseTo(baseline.width, 0);
    expect(afterAll.width).toBeGreaterThan(600);
  });

  test('[U04] closing the last sidebar gives the whole window to the reader', async ({
    window,
    workspace,
  }) => {
    const [first] = workspace.pdfDocuments;
    expect(first).toBeDefined();
    if (first === undefined) return;

    await window
      .locator(`[data-testid="library-sidebar"] [data-testid="library-item-${first.id}"]`)
      .click();
    const reader = window.locator(`[data-testid="pdf-reader"][data-document-id="${first.id}"]`);
    await expect(reader).toBeVisible();
    const withSidebar = await reader.boundingBox();
    expect(withSidebar).not.toBeNull();
    if (withSidebar === null) return;

    // Pressing the open sidebar's own button closes it — the slot is a toggle, not a switch
    // that can only ever be moved between four positions.
    await window.locator('[data-testid="activity-library"]').click();
    await expect(leftSidebars(window)).toHaveCount(0);

    // Polled, because Dockview relayouts from a ResizeObserver: the sidebar leaving the DOM
    // and the reader being told its new size are two different frames. This assertion is also
    // what keeps the sibling test honest — it proves the reader's width tracks the space it
    // is given, so "unchanged across four swaps" there means something.
    await expect
      .poll(async () => (await reader.boundingBox())?.width ?? 0, { timeout: 10_000 })
      .toBeGreaterThan(withSidebar.width);
  });
});

test.describe('controls that cannot act yet', () => {
  test('[U05] the graph button says what it needs when nothing is selected', async ({ window }) => {
    // A fresh workspace: the library is listed, but nothing is open, so there is no entity
    // for the graph to be a graph *of*. The button is enabled — pressing it is a reasonable
    // thing to do — and it used to report `no entity to act on`, which is true and tells a
    // reader nothing about what would work instead.
    await expect(window.locator('[data-testid="workspace-watermark"]')).toBeVisible();
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
    // The librarian is off on a fresh library, which is what disables "Run a pass now".
    const sidebar = window.locator('[data-testid="librarian-sidebar"]');
    await expect(async () => {
      if (!(await sidebar.isVisible())) {
        await window.locator('[data-testid="activity-librarian"]').click();
      }
      await expect(sidebar).toBeVisible({ timeout: 2_000 });
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
