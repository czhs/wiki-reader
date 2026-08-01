/**
 * The librarian, driven the way a person drives it (criteria A03, A05, A10).
 *
 * These three are E2E because each is a claim about the *application*, not about a module.
 * `A03` says a fresh install has agents off and discloses what would be sent before anything
 * can be enabled — which is a statement about what a running app has and has not done, and is
 * asserted here against the filesystem as well as the screen: with agents off, no wiki was
 * ever written out. `A05` and `A10` are about the two things the panel is for: deciding a
 * proposal, and following a citation back to where it came from.
 *
 * The proposals are staged before launch through the app's own workspace and reader, so every
 * citation on screen is one that resolved against this database. See `support/librarian.ts`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, test, expect, type LaunchedApp } from './support/app.js';
import { librarianNotes, seedHighlight, stageConnection } from './support/librarian.js';
import type { Page } from '@playwright/test';

/**
 * Bring the librarian up over the workspace, from the wiki (`F07`).
 *
 * There is no sidebar to toggle any more, so this opens the wiki — the page the librarian
 * proposes links *on* — and presses its Librarian button. Retried as a whole because a cold
 * start is still laying the workspace out when the first click lands.
 */
async function openLibrarian(window: Page): Promise<void> {
  const popup = window.locator('[data-testid="librarian-popup"]');
  await expect(async () => {
    if (!(await popup.isVisible())) {
      await window.locator('[data-testid="activity-wiki"]').click();
      await window.locator('[data-testid="wiki-librarian"]').click();
    }
    await expect(popup).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * The librarian has no sidebar; it comes up over the workspace, from the wiki (`F07`).
 *
 * It was one of the left sidebars, and that was the wrong shape for it twice over. A column
 * narrow enough to sit beside a reader is too narrow to read a proposal and its citations in;
 * and a panel that has to stay open while you decide takes the width permanently, from the
 * reading the decision is about. Deciding a proposal is a sitting, not a glance at a filter.
 *
 * It opens from the wiki because that is what it is about: the librarian reads the library and
 * proposes edges for that picture, so the page that draws them is where you would go to ask.
 */
test('[F07] the librarian pops up from the wiki, and has no sidebar of its own', async ({
  workspace,
}) => {
  const launched: LaunchedApp = await launchApp(workspace);
  try {
    const window = launched.window;
    await expect(window.locator('[data-testid="app-shell"]')).toBeVisible();

    // No door on the activity bar, and no slot in the left sidebar for it to occupy: switching
    // between the sidebars that are left never produces one.
    await expect(window.locator('[data-testid="activity-librarian"]')).toHaveCount(0);
    await expect(window.locator('[data-testid="librarian-sidebar"]')).toHaveCount(0);
    for (const which of ['activity-questions', 'activity-library']) {
      await window.locator(`[data-testid="${which}"]`).click();
      await expect(window.locator('.wr-sidebar--left [data-testid="librarian-view"]')).toHaveCount(
        0,
      );
      await expect(window.locator('[data-testid="librarian-sidebar"]')).toHaveCount(0);
    }

    // The way in is on the wiki, and it brings up the whole panel — the disclosure, the switch
    // and the proposals — rather than a smaller edition of it.
    const wiki = window.locator('[data-testid="wiki-panel"]');
    await expect(async () => {
      if (!(await wiki.isVisible())) await window.locator('[data-testid="activity-wiki"]').click();
      await expect(wiki).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    const tabsBefore = await window.locator('[data-testid="dockview-container"] .dv-tab').count();
    const wikiBefore = await wiki.boundingBox();
    if (wikiBefore === null) throw new Error('the wiki is not on screen');

    await window.locator('[data-testid="wiki-librarian"]').click();
    const popup = window.locator('[data-testid="librarian-popup"]');
    await expect(popup).toBeVisible();
    await expect(popup.locator('[data-testid="agent-disclosure"]')).toBeVisible();
    await expect(popup.locator('[data-testid="agent-switch"]')).toHaveAttribute(
      'data-enabled',
      'false',
    );
    await expect(popup.locator('[data-testid="agent-capabilities"]')).toBeVisible();

    // Over the workspace, not beside it: it stands on the same scrim every other sheet uses,
    // it is drawn across the page it came from, and — the whole point of the move — the page
    // underneath kept every pixel of its width instead of being squeezed into a column.
    await expect(window.locator('[data-testid="librarian-overlay"]')).toBeVisible();
    const popupBox = await popup.boundingBox();
    const wikiAfter = await wiki.boundingBox();
    if (popupBox === null || wikiAfter === null) throw new Error('nothing is on screen');
    expect(wikiAfter.width).toBeCloseTo(wikiBefore.width, 0);
    expect(wikiAfter.x).toBeCloseTo(wikiBefore.x, 0);
    expect(popupBox.x).toBeLessThan(wikiAfter.x + wikiAfter.width);
    expect(popupBox.x + popupBox.width).toBeGreaterThan(wikiAfter.x);
    // And it cost the workspace no tab at all.
    expect(await window.locator('[data-testid="dockview-container"] .dv-tab').count()).toBe(
      tabsBefore,
    );

    // Dismissed the way every sheet is, and the wiki is untouched behind it.
    await window.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
    await expect(wiki).toBeVisible();

    await window.locator('[data-testid="wiki-librarian"]').click();
    await expect(popup).toBeVisible();
  } finally {
    await launched.app.close();
  }

  // A sidebar is part of the saved layout and comes back; a sheet over the workspace is not,
  // and must not. A restart that reopened with the librarian standing over the reading would
  // be the sidebar's worst habit surviving the move.
  const again: LaunchedApp = await launchApp(workspace);
  try {
    await expect(again.window.locator('[data-testid="app-shell"]')).toBeVisible();
    await expect(again.window.locator('[data-testid="librarian-popup"]')).toHaveCount(0);
  } finally {
    await again.app.close();
  }
});

test('[A03] agents are off on a fresh library, and enabling them discloses what would be sent first', async ({
  workspace,
}) => {
  const launched: LaunchedApp = await launchApp(workspace);
  try {
    const window = launched.window;
    await openLibrarian(window);

    // Off. Not "off unless something switched it on during startup" — off.
    const control = window.locator('[data-testid="agent-switch"]');
    await expect(control).toHaveAttribute('data-enabled', 'false');
    await expect(window.locator('[data-testid="agent-run"]')).toBeDisabled();

    // The disclosure is on screen before the switch is reachable, and it is specific: where
    // it goes, whose credentials pay for it, and how much of the wiki would be sent.
    const disclosure = window.locator('[data-testid="agent-disclosure"]');
    await expect(disclosure).toBeVisible();
    await expect(disclosure.locator('[data-testid="agent-disclosure-destination"]')).toContainText(
      'Anthropic',
    );
    await expect(disclosure.locator('[data-testid="agent-disclosure-credentials"]')).toContainText(
      'credentials',
    );
    const sends = disclosure.locator('[data-testid="agent-disclosure-sends"] li');
    await expect(sends.first()).toContainText('documents');
    // Counted from the library rather than described in the abstract: everything imported
    // from Zotero *and* every page of the markdown corpus, because the wiki is the whole app
    // and a disclosure naming only half of it would be the more dangerous kind of wrong.
    await expect(sends.first()).toContainText(
      String(workspace.documents.length + workspace.corpusPageCount),
    );
    await expect(
      disclosure.locator('[data-testid="agent-disclosure-withholds"] li').first(),
    ).toBeVisible();
    // What it is *not* given is part of the disclosure. No web tool, so no fetch.
    await expect(disclosure.locator('[data-testid="agent-disclosure-tools"]')).not.toContainText(
      'WebFetch',
    );

    // And the strongest form of "off": nothing has been prepared to send. The wiki is
    // materialised at the start of a pass and nowhere else, so its absence here means no pass
    // was scheduled, started, or quietly warmed up by opening the panel.
    expect(existsSync(join(workspace.agentRoot, 'wiki'))).toBe(false);

    await window.locator('[data-testid="agent-enable"]').click();
    await expect(control).toHaveAttribute('data-enabled', 'true');
    // The acknowledgement is now recorded, so the button stops asking for it.
    await expect(window.locator('[data-testid="agent-enable"]')).toHaveText(
      'Turn the librarian off',
    );
    await expect(window.locator('[data-testid="agent-run"]')).toBeEnabled();
  } finally {
    await launched.app.close();
  }
});

test('[A05] accepting a proposal writes it into the workspace, and rejecting writes nothing', async ({
  workspace,
}) => {
  const [first, second] = workspace.pdfDocuments;
  if (first === undefined || second === undefined) throw new Error('need two PDFs');

  const keep = await stageConnection(workspace, {
    title: 'Both papers describe one width sweep',
    body: `The same sweep is read two ways in [[${first.id}]] and [[${second.id}]].`,
    threads: [first.id, second.id],
  });
  const drop = await stageConnection(workspace, {
    title: 'A thin observation not worth keeping',
    body: `Both of [[${first.id}]] and [[${second.id}]] mention a transformer.`,
    threads: [first.id, second.id],
  });

  expect(librarianNotes(workspace)).toEqual([]);

  const launched: LaunchedApp = await launchApp(workspace);
  try {
    const window = launched.window;
    await openLibrarian(window);

    await expect(window.locator('[data-testid="agent-pending-count"]')).toHaveText('2');
    await expect(window.locator(`[data-testid="proposal-${keep.id}"]`)).toBeVisible();

    await window.locator(`[data-testid="accept-${keep.id}"]`).click();
    await expect(window.locator(`[data-testid="proposal-${keep.id}"]`)).toHaveCount(0);
    await expect(window.locator('[data-testid="agent-pending-count"]')).toHaveText('1');

    // The directory is the assertion, not the row: a proposal reported as accepted with
    // nothing on disk is a note the researcher believes is in their wiki and is not.
    await expect(() => {
      expect(librarianNotes(workspace)).toHaveLength(1);
    }).toPass({ timeout: 10_000 });
    const written = librarianNotes(workspace);

    await window.locator(`[data-testid="reject-${drop.id}"]`).click();
    await expect(window.locator(`[data-testid="proposal-${drop.id}"]`)).toHaveCount(0);
    await expect(window.locator('[data-testid="agent-no-proposals"]')).toBeVisible();

    // Rejecting wrote nothing: the workspace is exactly what the accept left behind.
    expect(librarianNotes(workspace)).toEqual(written);
  } finally {
    await launched.app.close();
  }
});

test('[A10] clicking a citation opens its source at the place it came from', async ({
  workspace,
}) => {
  const [first, second] = workspace.pdfDocuments;
  if (first === undefined || second === undefined) throw new Error('need two PDFs');

  // On the second page, so "opened the document" and "opened it at the citation's location"
  // cannot both be satisfied by simply rendering page one.
  const PAGE_INDEX = 1;
  const highlightId = seedHighlight(workspace, {
    documentId: second.id,
    pageIndex: PAGE_INDEX,
    text: 'the residual stream carries the features forward',
  });

  const proposal = await stageConnection(workspace, {
    title: 'A highlight that answers the other paper',
    body: `What [[${first.id}]] leaves open is marked in [[${highlightId}]].`,
    threads: [first.id, highlightId],
  });
  expect(proposal.citations.map((citation) => citation.entityId)).toContain(highlightId);

  const launched: LaunchedApp = await launchApp(workspace);
  try {
    const window = launched.window;
    await openLibrarian(window);
    await expect(window.locator(`[data-testid="proposal-${proposal.id}"]`)).toBeVisible();

    await window.locator(`[data-testid="citation-${highlightId}"]`).click();

    // The source, opened.
    const reader = window.locator(`[data-testid="pdf-reader"][data-document-id="${second.id}"]`);
    await expect(reader).toBeVisible();
    await expect(reader.locator('[data-testid="pdf-total-pages"]')).toHaveText(/^\d+ pages$/);

    // …at the citation's location. The reader scrolls the cited page to the top of the
    // viewport, so the scroll offset is that page's own offset and not zero.
    await expect(async () => {
      const landed = await reader.evaluate((element, pageIndex) => {
        const scroller = element.querySelector('[data-testid="pdf-scroll"]');
        const page = element.querySelector(`[data-page-index="${String(pageIndex)}"]`);
        if (!(scroller instanceof HTMLElement) || !(page instanceof HTMLElement)) return null;
        return { scrollTop: scroller.scrollTop, pageTop: page.offsetTop };
      }, PAGE_INDEX);
      expect(landed).not.toBeNull();
      if (landed === null) return;
      expect(landed.pageTop).toBeGreaterThan(0);
      expect(Math.abs(landed.scrollTop - landed.pageTop)).toBeLessThan(8);
    }).toPass({ timeout: 30_000 });
  } finally {
    await launched.app.close();
  }
});
