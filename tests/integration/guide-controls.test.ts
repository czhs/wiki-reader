/**
 * The other half of the guide's coverage (`O01`): the features that are not commands.
 *
 * `guide.test.ts` proves the guide covers every registered command, and it can do that against
 * the registry itself because a command *is* a registry entry. A panel control is not: the
 * graph's filter, the saved page's zoom lever, discard and delete on the shelf all act on the
 * panel in front of you, so putting them on the global command registry would buy nothing and
 * cost a `when` clause each. They are declared in `PANEL_CONTROLS` instead — which is only worth
 * anything if that declaration and the running app cannot drift apart.
 *
 * So this test reads the renderer's own source and insists the two sets are equal in **both**
 * directions:
 *
 * - every `data-control="…"` a panel draws is an id `PANEL_CONTROLS` declares — so a typo, or a
 *   control someone added without registering it, fails here rather than becoming a feature the
 *   guide has never heard of;
 * - every id `PANEL_CONTROLS` declares is drawn by some panel — so a control that has been
 *   removed cannot go on being described by the guide as though it were still there.
 *
 * And `guide.test.ts` will not let a control be registered without a chapter covering it. The
 * three together are the mechanism behind "from milestone 6 on, a feature is not done until the
 * guide shows it": it is not a habit anybody has to remember.
 *
 * Reading source in a test is unusual and is the point — the attribute is the only evidence that
 * a widget exists, and no runtime check can enumerate every panel without driving all of them.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PANEL_CONTROLS } from '@wr/workbench';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Where a panel control can live: the renderer, and the reader packages that draw their own
 * chrome. Not `packages/workbench/src`, which is where the declaration itself is.
 */
const SOURCE_ROOTS = [
  'apps/desktop/src/renderer',
  'packages/pdf-reader/src',
  'packages/html-reader/src',
  'packages/markdown-reader/src',
  'packages/annotations/src',
  'packages/note-editor/src',
  'packages/shared-ui/src',
];

function sourceFiles(root: string): string[] {
  const absolute = join(REPO, root);
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) {
        found.push(path);
      }
    }
  };
  walk(absolute);
  return found;
}

/** `data-control="…"` as it is written in JSX, with the file it was found in. */
function drawnControls(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const root of SOURCE_ROOTS) {
    for (const path of sourceFiles(root)) {
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(/data-control="([^"]*)"/g)) {
        const id = match[1] ?? '';
        const where = found.get(id);
        const relative = path.slice(REPO.length);
        if (where === undefined) found.set(id, [relative]);
        else if (!where.includes(relative)) where.push(relative);
      }
      // A computed id would defeat the whole check: nothing can be read out of source about
      // `data-control={whatever}`, so the attribute is a literal here by rule.
      expect(
        /data-control=\{/.test(source),
        `${path.slice(REPO.length)} computes its data-control; it has to be a literal so the guide can be checked against it`,
      ).toBe(false);
    }
  }
  return found;
}

describe('the guide’s panel controls and the panels that draw them', () => {
  it('[O01] declares every control the app draws, and draws every control it declares', () => {
    const drawn = drawnControls();
    const declared = new Set(PANEL_CONTROLS.map((control) => control.id));

    const undeclared = [...drawn.keys()].filter((id) => !declared.has(id as never));
    expect(
      undeclared,
      'a panel draws these controls and PANEL_CONTROLS does not declare them, so the guide cannot show them',
    ).toEqual([]);

    const undrawn = [...declared].filter((id) => !drawn.has(id));
    expect(
      undrawn,
      'the guide describes these controls and no panel draws them any more',
    ).toEqual([]);
  });

  it('[O01] the controls the milestone named are on the surfaces it named them on', () => {
    // A spot check with teeth: set equality above would still pass if every control had
    // migrated into one file. These four are the ones milestone 6 turned on, and each has to
    // be drawn by the surface its guide entry sends the researcher to.
    const drawn = drawnControls();
    const on = (id: string): string => (drawn.get(id) ?? []).join(' ');

    expect(on('graph.find')).toContain('graph-canvas.tsx');
    expect(on('snapshot.zoom')).toContain('HtmlReaderView.tsx');
    expect(on('journal.calendar')).toContain('journal-panel.tsx');
    expect(on('notebook.excerpt')).toContain('notebook-panel.tsx');
    // Discard and delete are the queue's, and delete is offered only on the discarded shelf —
    // so both are in the one file that guards that order.
    expect(on('notebook.discard')).toContain('queue-panel.tsx');
    expect(on('notebook.delete')).toContain('queue-panel.tsx');
  });
});
