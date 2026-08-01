/**
 * The help page shows every command doing what it does (criterion `D03`).
 *
 * `D02` proved the page is the registries printed: a row per command, a row per binding, no
 * hand-written sheet anywhere. The researcher's complaint at that point was that a page of
 * fifty-two names is a glossary of a language they do not speak — the names are honest and
 * they do not say what happens when you press one. `D03` is the answer: beside every command,
 * a small picture of its own act, running.
 *
 * Each clause is a test here, and the important one is *every*. A page where most commands
 * have a drawing and six do not is exactly the failure the criterion names, so the set of
 * commands is read off the running app (`data-command-count`, and the rows themselves) rather
 * than from a list written in this file, and the assertion is that the drawings and the rows
 * are the same size.
 *
 * The rest is the guide's own machinery, inherited on purpose: the motion is inline SVG
 * animated by keyframes the app ships, nothing is fetched, and asking for less motion stops
 * all of it and leaves a still diagram rather than a blank.
 */
import { COMMAND_IDS } from '@wr/workbench';
import type { Page } from '@playwright/test';
import { test, expect } from './support/app.js';
import { press } from './support/keys.js';

const help = (window: Page) => window.locator('[data-testid="help-panel"]');

async function openHelp(window: Page): Promise<void> {
  await window.locator('[data-testid="status-help"]').click();
  await expect(help(window)).toBeVisible();
}

/** Every command id the page draws a card for — which is every command the registry holds. */
async function commandRows(window: Page): Promise<string[]> {
  return help(window)
    .locator('[data-testid="help-features"] .wr-help__command')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-command-id') ?? ''));
}

test('[D03] every command on the help page carries a picture of its own act', async ({
  window,
}) => {
  await openHelp(window);

  const rows = await commandRows(window);
  expect(rows.length).toBeGreaterThan(20);
  expect(rows).not.toContain('');
  // The page's own count, computed from `commands.all()` when it mounted: a card per command
  // and no more, so nothing can be shown a picture for that the app cannot actually do.
  await expect(help(window)).toHaveAttribute('data-command-count', String(rows.length));
  // And the mapping still fits the registry — a category nobody drew for would give every
  // command in it the same fallback drawing, which the page reports rather than hides.
  await expect(help(window)).toHaveAttribute('data-motion-complete', 'true');

  // One drawing per command, each an inline SVG the app ships. Counted rather than sampled:
  // "every command" is the whole of the criterion.
  const drawings = help(window).locator('[data-testid="help-features"] svg.wr-guide__motion');
  await expect(drawings).toHaveCount(rows.length);

  for (const commandId of rows) {
    const row = window.locator(`[data-testid="help-command-${commandId}"]`);
    await expect(row.locator('svg.wr-guide__motion'), `${commandId} is not drawn`).toHaveCount(1);
    // Which drawing it is, said on the row, so a picture that is wrong for the act is a fact
    // about the page rather than something only a person watching could notice.
    const motion = await row.getAttribute('data-motion');
    expect(motion, `${commandId} names no drawing`).toBeTruthy();
    // A picture is not an explanation on its own: the artwork carries its own label.
    const label = await row.locator('svg.wr-guide__motion').getAttribute('aria-label');
    expect((label ?? '').length, `${commandId}'s drawing says nothing`).toBeGreaterThan(10);
  }
});

test('[D03] the pictures really move, and the ones that differ show different acts', async ({
  window,
}) => {
  await openHelp(window);
  // Deterministic rather than inherited from whoever's machine this is running on.
  await window.emulateMedia({ reducedMotion: 'no-preference' });

  /** How many command cards have at least one part the browser is actually animating. */
  const animatedCards = async (): Promise<number> =>
    help(window)
      .locator('[data-testid="help-features"] .wr-help__command')
      .evaluateAll((cards) =>
        cards.filter((card) =>
          Array.from(card.querySelectorAll('svg.wr-guide__motion *')).some((element) => {
            const style = getComputedStyle(element);
            return (
              style.animationName !== 'none' &&
              style.animationName !== '' &&
              Number.parseFloat(style.animationDuration) > 0
            );
          }),
        ).length,
      );

  const rows = await commandRows(window);
  expect(await animatedCards()).toBe(rows.length);

  // Not one drawing repeated fifty-two times. A category says what a command is *about* and a
  // picture has to show what it *does*, which is why making a link and taking one away are
  // drawn differently even though both are Links — the pair a single-table mapping would draw
  // identically, and the one where an identical drawing would demonstrate the opposite act.
  const motionOf = async (commandId: string): Promise<string> =>
    (await window.locator(`[data-testid="help-command-${commandId}"]`).getAttribute('data-motion')) ??
    '';
  expect(await motionOf(COMMAND_IDS.deleteLink)).not.toBe(
    await motionOf(COMMAND_IDS.createDocumentLink),
  );
  expect(await motionOf(COMMAND_IDS.closeTab)).not.toBe(await motionOf(COMMAND_IDS.openHelp));
  const drawn = new Set(
    await help(window)
      .locator('[data-testid="help-features"] .wr-help__command')
      .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-motion') ?? '')),
  );
  expect(drawn.size, 'the whole page is one picture').toBeGreaterThan(6);

  // Nothing on this page is fetched. A local-first reader that reached a CDN to explain itself
  // would be contradicting the sentence it was drawing.
  const remote = await window.evaluate(() => {
    const page = document.querySelector('[data-testid="help-panel"]');
    const found: string[] = [];
    for (const element of Array.from(page?.querySelectorAll('[src], [href], [xlink\\:href]') ?? [])) {
      const value =
        element.getAttribute('src') ??
        element.getAttribute('href') ??
        element.getAttribute('xlink:href') ??
        '';
      if (/^(https?:)?\/\//i.test(value)) found.push(value);
    }
    return found;
  });
  expect(remote, 'the help page draws from what ships with the app, never from a CDN').toEqual([]);
});

test('[D03] asked for less motion, the drawings hold still rather than disappear', async ({
  window,
}) => {
  // Reached by its own chord as well as the status bar, for the reason `K03` gives.
  await press(window, COMMAND_IDS.openHelp);
  await expect(help(window)).toBeVisible();

  await window.emulateMedia({ reducedMotion: 'reduce' });
  const stillRunning = await help(window)
    .locator('[data-testid="help-features"] svg.wr-guide__motion *')
    .evaluateAll((elements) =>
      elements.filter((element) => {
        const style = getComputedStyle(element);
        return style.animationName !== 'none' && style.animationName !== '';
      }).length,
    );
  expect(stillRunning, 'a drawing kept moving after less motion was asked for').toBe(0);

  // …and the artwork is still there, because every drawing's resting state is its own
  // attributes rather than the first frame of a keyframe set.
  const first = help(window).locator('[data-testid="help-features"] svg.wr-guide__motion').first();
  await first.scrollIntoViewIfNeeded();
  await expect(first).toBeVisible();
  const box = await first.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThan(20);

  await window.emulateMedia({ reducedMotion: 'no-preference' });
});
