/**
 * The guide (criterion `O01`), against a real Electron process.
 *
 * The criterion is "a guide page covers every feature the registries know, showing how to use it
 * — with motion where showing beats telling", and each clause is a test here.
 *
 * *Covers every feature the registries know* is the one that can rot, so it is asserted the only
 * way that cannot: against the **help page**, which is `commands.all()` and `keybindings.all()`
 * rendered (`D02`). Every command the help page lists must have a chapter in the guide. Reading
 * the registry through the app's own rendering of it, rather than importing `COMMAND_IDS` here,
 * is what makes this an assertion about the running application rather than about a constant.
 *
 * *Showing how to use it* is why the second test insists the guide is not simply the help page
 * with pictures: chapters, prose, numbered steps, and — the part that would be easy to fake —
 * that the words on it are the registry's own, so a renamed command is renamed here too.
 *
 * *With motion* is asserted as real running animation, computed by the browser, and as motion
 * that stops when the person has asked for less of it. And as motion that ships: nothing on this
 * page may come from a remote origin, which for a local-first reader is not a detail.
 *
 * The last test is the other half of coverage. Not everything the app does is a command — the
 * graph's filter and the saved page's zoom lever are panel controls — so the guide claims those
 * separately, and the claim is checked against the panel that actually draws them.
 */
import {
  COMMAND_IDS,
  DEFAULT_KEYBINDINGS,
  PANEL_CONTROLS,
  parseKeystroke,
  type Keystroke,
} from '@wr/workbench';
import type { Page } from '@playwright/test';
import { test, expect } from './support/app.js';

function chordFor(commandId: string): Keystroke {
  const rule = DEFAULT_KEYBINDINGS.find((candidate) => candidate.commandId === commandId);
  if (rule === undefined) throw new Error(`no default keybinding for ${commandId}`);
  return parseKeystroke(process.platform === 'darwin' ? (rule.mac ?? rule.key) : rule.key);
}

function pressable(keystroke: Keystroke): string {
  const parts: string[] = [];
  if (keystroke.ctrl) parts.push('Control');
  if (keystroke.alt) parts.push('Alt');
  if (keystroke.shift) parts.push('Shift');
  if (keystroke.meta) parts.push('Meta');
  parts.push(keystroke.key);
  return parts.join('+');
}

const guide = (window: Page) => window.locator('[data-testid="guide-panel"]');

/** Every command id the help page lists — which is every command the registry holds. */
async function registeredCommandIds(window: Page): Promise<string[]> {
  await window.locator('[data-testid="status-help"]').click();
  const help = window.locator('[data-testid="help-panel"]');
  await expect(help).toBeVisible();
  return help
    .locator('[data-testid="help-features"] [data-command-id]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-command-id') ?? ''));
}

test('[O01] the guide accounts for every command the registry holds, and says so on the page', async ({
  window,
}) => {
  const registered = await registeredCommandIds(window);
  expect(registered.length).toBeGreaterThan(20);

  await window.locator('[data-testid="status-guide"]').click();
  await expect(guide(window)).toBeVisible();

  // The page's own verdict, computed against `commands.all()` when it mounted. It is on the
  // page and not only in this test on purpose: a gap has to be visible to whoever is looking
  // at the app, not only to CI.
  await expect(guide(window)).toHaveAttribute('data-uncovered-count', '0');
  await expect(guide(window)).toHaveAttribute('data-unknown-count', '0');
  await expect(guide(window)).toHaveAttribute('data-uncovered-controls', '0');
  await expect(guide(window)).toHaveAttribute('data-complete', 'true');
  await expect(window.locator('[data-testid="guide-gaps"]')).toHaveCount(0);
  await expect(guide(window)).toHaveAttribute('data-command-count', String(registered.length));

  // And the verdict, checked rather than believed: every command on the help page has a
  // chapter of the guide that names it. This is the assertion the criterion turns on — a
  // command the guide has never heard of fails here even if the page thinks it is complete.
  const covered = await guide(window)
    .locator('[data-guide-covers]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-guide-covers') ?? ''));
  const uncovered = registered.filter((id) => !covered.includes(id));
  expect(uncovered, 'the app can do these things and no chapter of the guide shows them').toEqual(
    [],
  );
  // …and nothing the guide covers has since stopped existing.
  expect(covered.filter((id) => !registered.includes(id))).toEqual([]);
});

test('[O01] it shows what the app does rather than listing what the keys are', async ({
  window,
}) => {
  // The help page's rendering of one command, kept for the comparison at the end of this test.
  await registeredCommandIds(window);
  const onHelp = await window.evaluate(() => {
    const row = document.querySelector('[data-testid="help-command-wr.openWiki"]');
    return {
      title: row?.querySelector('.wr-help__command-title')?.textContent ?? '',
      chord: row?.querySelector('kbd')?.textContent ?? '',
    };
  });
  expect(onHelp.title.length).toBeGreaterThan(0);
  expect(onHelp.chord.length).toBeGreaterThan(0);

  // Reached by its own chord as well as by the status bar: a page about how to use the app
  // that could only be opened by already knowing how would be its own counter-example.
  await window.keyboard.press(pressable(chordFor(COMMAND_IDS.openGuide)));
  await expect(guide(window)).toBeVisible();

  const chapters = guide(window).locator('[data-testid^="guide-chapter-"]');
  const chapterCount = await chapters.count();
  expect(chapterCount).toBeGreaterThan(5);
  await expect(guide(window)).toHaveAttribute('data-chapter-count', String(chapterCount));

  // Every chapter is an account of something: a title, prose about what the app does there,
  // and numbered steps for doing it. The help page has none of that and cannot grow it —
  // that difference is what the criterion means by "the guide is not the help page".
  for (let index = 0; index < chapterCount; index += 1) {
    const chapter = chapters.nth(index);
    await expect(chapter.locator('.wr-guide__chapter-title')).toHaveCount(1);
    const lede = (await chapter.locator('.wr-guide__lede').innerText()).trim();
    expect(lede.length, 'a chapter with no prose is a list with a heading').toBeGreaterThan(80);
    expect(await chapter.locator('.wr-guide__step').count()).toBeGreaterThan(0);
  }

  // The words are the registries', not this page's. The title beside a step and the chord on
  // it both come out of the two registries at draw time, exactly as the help page and the
  // context menus do — so a renamed command or a rebound key moves here with it.
  const wikiChip = guide(window).locator('[data-guide-covers="wr.openWiki"]');
  await expect(wikiChip).toContainText(onHelp.title);
  await expect(wikiChip.locator('kbd')).toHaveText(onHelp.chord);
});

test('[O01] the motion runs, ships with the app, and stops when it is asked to', async ({
  window,
}) => {
  await window.locator('[data-testid="status-guide"]').click();
  await expect(guide(window)).toBeVisible();

  // Deterministic rather than inherited from whoever's machine this is running on.
  await window.emulateMedia({ reducedMotion: 'no-preference' });

  const figures = guide(window).locator('svg.wr-guide__motion');
  const chapterCount = Number(await guide(window).getAttribute('data-chapter-count'));
  await expect(figures).toHaveCount(chapterCount);

  /** How many chapters have at least one part the browser is actually animating. */
  const animatedChapters = async (): Promise<number> =>
    guide(window)
      .locator('svg.wr-guide__motion')
      .evaluateAll((figures_) =>
        figures_.filter((figure) =>
          [figure, ...figure.querySelectorAll('*')].some((element) => {
            const style = getComputedStyle(element);
            return (
              style.animationName !== 'none' &&
              style.animationName !== '' &&
              Number.parseFloat(style.animationDuration) > 0
            );
          }),
        ).length,
      );

  // Every chapter moves. Not "the page contains an animation somewhere" — the criterion is
  // motion where showing beats telling, and a picture per chapter is what that means here.
  expect(await animatedChapters()).toBe(chapterCount);

  // And each figure carries a written caption, because a demonstration that only means
  // something to someone watching it is not an explanation.
  for (const caption of await guide(window).locator('.wr-guide__caption').all()) {
    expect((await caption.innerText()).trim().length).toBeGreaterThan(10);
  }

  // Nothing on this page is fetched. A local-first reader that reached a CDN to explain
  // itself would be contradicting the sentence it was drawing.
  const remote = await window.evaluate(() => {
    const page = document.querySelector('[data-testid="guide-panel"]');
    const found: string[] = [];
    for (const element of Array.from(page?.querySelectorAll('[src], [href], [xlink\\:href]') ?? [])) {
      const value =
        element.getAttribute('src') ??
        element.getAttribute('href') ??
        element.getAttribute('xlink:href') ??
        '';
      if (/^(https?:)?\/\//i.test(value)) found.push(value);
    }
    // The app's own bundle is served over `app://` in production and `file:` from the tree;
    // what must not appear is an http(s) origin, which is the only way a stylesheet could have
    // come from somewhere other than this machine.
    const sheets = Array.from(document.styleSheets)
      .map((sheet) => sheet.href)
      .filter((href): href is string => href !== null && /^https?:/i.test(href));
    return [...found, ...sheets];
  });
  expect(remote, 'the guide is drawn from what ships with the app, never from a CDN').toEqual([]);

  // Asked for less motion, it stops — and the artwork is still there, because every drawing's
  // resting state is its own attributes rather than the first frame of a keyframe set.
  await window.emulateMedia({ reducedMotion: 'reduce' });
  expect(await animatedChapters()).toBe(0);
  await expect(figures.first()).toBeVisible();
  await window.emulateMedia({ reducedMotion: 'no-preference' });
});

test('[O01] the features that are not commands are covered too, and the panels really draw them', async ({
  window,
}) => {
  await window.locator('[data-testid="status-guide"]').click();
  await expect(guide(window)).toBeVisible();

  // Every declared panel control has a chapter. `PANEL_CONTROLS` is imported here rather than
  // read off the page for the same reason the commands were read *off* the page: the two
  // halves have opposite failure modes. A command the guide missed is invisible unless the
  // registry is the source; a control the guide invented is invisible unless the declaration is.
  const claimed = await guide(window)
    .locator('[data-guide-control]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-guide-control') ?? ''));
  for (const control of PANEL_CONTROLS) {
    expect(claimed, `the guide never mentions ${control.id}`).toContain(control.id);
  }

  // And a claim about a control is a claim about a widget that exists. The wiki is the
  // cheapest surface to prove it on: the guide says the map can be searched in place, and the
  // map the app opens carries exactly the control the guide named.
  await expect(guide(window).locator('[data-guide-control="graph.find"]')).toContainText('Find');
  await window.keyboard.press(pressable(chordFor(COMMAND_IDS.openWiki)));
  const wiki = window.locator('[data-testid="wiki-panel"]');
  await expect(wiki).toBeVisible();
  await expect(wiki.locator('[data-control="graph.find"]')).toHaveCount(1);
});
