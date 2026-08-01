/**
 * The guide, asserted as what it has to be: complete, and unable to become incomplete quietly.
 *
 * The criterion (`O01`) is "a guide page covers every feature the registries know". A guide that
 * covered everything on the day it was written and then fell one command behind would pass every
 * "does the page render" test while failing exactly what was asked for — so the load-bearing
 * assertion here is against the live `Workbench`'s registries rather than against `COMMAND_IDS`,
 * and the last test proves the mechanism actually fails when something is uncovered, rather than
 * only asserting that it currently does not.
 *
 * The prose is not tested and cannot be. What is tested is that there *is* prose, that every
 * chapter has a picture, and that nothing is named that does not exist.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Link, NavigationLocation, ResolvedLink } from '@wr/shared-types';
import type { EntityRef } from '../src/entity-links.js';
import type { PanelDescriptor } from '../src/layout.js';
import { emptyWorkspaceSnapshot, type OpenPlan, type WorkspaceSnapshot } from '../src/panel-targets.js';
import { CommandRegistry } from '../src/commands.js';
import { contextMenuKinds } from '../src/menus.js';
import {
  GUIDE_CHAPTERS,
  GUIDE_MOTIONS,
  PANEL_CONTROLS,
  guideCoverage,
  panelControl,
} from '../src/guide.js';
import {
  COMMAND_IDS,
  Workbench,
  type BlockActionRequest,
  type EntityLinkRequest,
  type WorkbenchHost,
} from '../src/workbench.js';

/** A host that answers nothing: the guide is built from the registries, never from the host. */
class SilentHost implements WorkbenchHost {
  getWorkspace(): WorkspaceSnapshot {
    return emptyWorkspaceSnapshot();
  }
  applyPlan(_plan: OpenPlan): void {}
  getActiveEntity(): EntityRef | null {
    return null;
  }
  getLinkUnderCursor(): EntityRef | null {
    return null;
  }
  describeEntity(_entity: EntityRef): PanelDescriptor | null {
    return null;
  }
  getLinks(): readonly Link[] {
    return [];
  }
  resolveLinks(): readonly ResolvedLink[] {
    return [];
  }
  closePanel(_panelId: string | null): void {}
  closeGroup(_groupId: string | null): void {}
  showReferences(): void {}
  stepReference(): void {}
  showPeek(): void {}
  revealInLibrary(): void {}
  toggleSidebar(): void {}
  copyToClipboard(): void {}
  showCommands(): void {}
  showFiles(): void {}
  notebookInHand(): Promise<string | null> {
    return Promise.resolve(null);
  }
  promptEntityLink(): void {}
  createEntityLink(_request: EntityLinkRequest): Promise<Link | null> {
    return Promise.resolve(null);
  }
  promptSendToNotebook(): void {}
  createNoteFrom(): Promise<string | null> {
    return Promise.resolve(null);
  }
  runBlockAction(_request: BlockActionRequest): void {}
  currentNavigationLocation(): NavigationLocation | null {
    return null;
  }
}

let workbench: Workbench;

beforeEach(() => {
  workbench = new Workbench(new SilentHost(), { platform: 'mac' });
});

describe('the guide covers what the registries know', () => {
  it('[O01] names every command the command registry holds, and nothing it does not', () => {
    const coverage = guideCoverage([...workbench.commands.all()], GUIDE_CHAPTERS, contextMenuKinds());

    expect(
      coverage.missing.map((command) => command.id),
      'these commands exist in the app and no chapter of the guide shows them',
    ).toEqual([]);
    expect(
      coverage.unknown,
      'the guide names these commands and nothing registers them',
    ).toEqual([]);
    expect(coverage.covered).toHaveLength([...workbench.commands.all()].length);
    expect(coverage.complete).toBe(true);
  });

  it('[O01] covers every panel control, which is where the features that are not commands live', () => {
    const coverage = guideCoverage([...workbench.commands.all()]);
    expect(
      coverage.missingControls,
      'a panel control with no chapter is a feature the guide does not show',
    ).toEqual([]);

    // And every control a chapter names is one the registry has — `panelControl` throws
    // otherwise, so this is the assertion that the ids in the chapters are real.
    for (const chapter of GUIDE_CHAPTERS) {
      for (const id of chapter.controls) expect(panelControl(id).id).toBe(id);
    }
  });

  it('[O01] covers every surface a right-click means something on', () => {
    const coverage = guideCoverage([...workbench.commands.all()], GUIDE_CHAPTERS, contextMenuKinds());
    expect(coverage.missingMenus).toEqual([]);
  });

  it('[O01] shows rather than tells: every chapter has prose, steps and a picture that moves', () => {
    expect(GUIDE_CHAPTERS.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    const motions = new Set<string>();
    for (const chapter of GUIDE_CHAPTERS) {
      expect(ids.has(chapter.id), `two chapters share the id ${chapter.id}`).toBe(false);
      ids.add(chapter.id);
      expect(chapter.title.length).toBeGreaterThan(0);
      // Long enough to be an account of what the app does rather than a restated title.
      expect(chapter.lede.length, `${chapter.id} has no lede`).toBeGreaterThan(80);
      expect(chapter.steps.length, `${chapter.id} has no steps`).toBeGreaterThan(0);
      for (const step of chapter.steps) expect(step.text.length).toBeGreaterThan(0);
      // A caption, because motion that cannot be seen still has to be readable.
      expect(chapter.motionCaption.length, `${chapter.id} has no caption`).toBeGreaterThan(0);
      expect(GUIDE_MOTIONS).toContain(chapter.motion);
      // One picture per chapter and no chapter reusing another's: the artwork is *of* the
      // thing, so two chapters sharing one would mean at least one of them is illustrated
      // with something else's diagram.
      expect(motions.has(chapter.motion), `${chapter.motion} is drawn twice`).toBe(false);
      motions.add(chapter.motion);
    }
    // No motion is drawn that no chapter asks for, so the renderer's keyframes and this list
    // stay the same set.
    expect([...motions].sort()).toEqual([...GUIDE_MOTIONS].sort());
  });

  it('[O01] steps name only real commands, so a step can print a chord that is current', () => {
    for (const chapter of GUIDE_CHAPTERS) {
      for (const step of chapter.steps) {
        if (step.commandId === undefined) continue;
        expect(
          workbench.commands.has(step.commandId),
          `${chapter.id} has a step running unregistered ${step.commandId}`,
        ).toBe(true);
        // And a step's command is one the chapter claims to cover, so the covered list under
        // a chapter is an account of that chapter rather than a separate one.
        expect(
          chapter.commands as readonly string[],
          `${chapter.id} runs ${step.commandId} without covering it`,
        ).toContain(step.commandId);
      }
    }
  });

  it('[O01] every panel control says where to find it and what it does', () => {
    const ids = new Set<string>();
    for (const control of PANEL_CONTROLS) {
      expect(ids.has(control.id), `two controls share the id ${control.id}`).toBe(false);
      ids.add(control.id);
      expect(control.title.length).toBeGreaterThan(0);
      expect(control.surface.length).toBeGreaterThan(0);
      expect(control.hint.length).toBeGreaterThan(20);
    }
  });
});

describe('the coverage check is what keeps the guide from rotting', () => {
  it('[O01] reports a command that no chapter shows, rather than passing quietly', () => {
    // The whole mechanism, exercised: a registry with one command the guide has never heard of.
    // If this test can be made to pass by weakening `guideCoverage`, the first one above stops
    // meaning anything.
    const registry = new CommandRegistry();
    registry.register({
      id: 'wr.somethingNobodyDocumented',
      title: 'Something Nobody Documented',
      category: 'View',
      handler: () => {},
    });
    registry.register({
      id: COMMAND_IDS.openGuide,
      title: 'Open Guide',
      category: 'View',
      handler: () => {},
    });

    const coverage = guideCoverage([...registry.all()]);
    expect(coverage.missing.map((command) => command.id)).toEqual([
      'wr.somethingNobodyDocumented',
    ]);
    expect(coverage.covered).toEqual([COMMAND_IDS.openGuide]);
    expect(coverage.complete).toBe(false);
  });

  it('[O01] reports a chapter that names a command the app no longer has', () => {
    const registry = new CommandRegistry();
    const coverage = guideCoverage(
      [...registry.all()],
      [
        {
          id: 'ghost',
          title: 'A chapter about a command that was deleted',
          lede: 'x'.repeat(100),
          motion: 'keys',
          motionCaption: 'nothing',
          steps: [{ text: 'do the thing' }],
          commands: ['wr.deletedLongAgo' as never],
          controls: [],
          menus: [],
        },
      ],
    );
    expect(coverage.unknown).toEqual(['wr.deletedLongAgo']);
    expect(coverage.complete).toBe(false);
  });

  it('[O01] reports a right-click surface no chapter teaches', () => {
    const coverage = guideCoverage([], [], ['library-row', 'block']);
    expect(coverage.missingMenus).toEqual(['library-row', 'block']);
  });
});
