/**
 * The context menus, asserted as what they are: a *reading* of the command registry (`R01`).
 *
 * The load-bearing test in this file is the first one. A menu that named a command nobody
 * registered would be exactly the failure the criterion forbids — a second, parallel list of
 * actions — and it would fail silently, as an item that quietly never appears. So the table is
 * checked against the registry rather than against a copy of itself.
 *
 * The rest are about the three ways an entry is kept off a menu: the context says no, the
 * target cannot supply what the command needs, or the thing is the wrong kind for it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Link, NavigationLocation, ResolvedLink } from '@wr/shared-types';
import type { EntityRef } from '../src/entity-links.js';
import type { PanelDescriptor } from '../src/layout.js';
import { emptyWorkspaceSnapshot, type OpenPlan, type WorkspaceSnapshot } from '../src/panel-targets.js';
import { CommandRegistry } from '../src/commands.js';
import { buildContextMenu, menuCommandIds, type ContextMenuKind } from '../src/menus.js';
import {
  COMMAND_IDS,
  Workbench,
  type BlockActionRequest,
  type EntityLinkRequest,
  type WorkbenchHost,
} from '../src/workbench.js';

const DOCUMENT = 'doc_01j0000000000000000000000a';
const ANNOTATION = 'ann_01j0000000000000000000000b';
const NOTE = 'not_01j0000000000000000000000c';
const NOTEBOOK = 'qst_01j0000000000000000000000d';

/** A host that answers nothing: a menu is built from the registries, never from the host. */
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

/** Every command id a menu offers for this target, flattened out of its groups. */
function idsOf(kind: ContextMenuKind, args: Readonly<Record<string, unknown>>): string[] {
  return workbench.contextMenu(kind, args).flatMap((group) => group.items.map((i) => i.commandId));
}

const fileArgs = {
  entityId: DOCUMENT,
  entityType: 'document',
  documentId: DOCUMENT,
  sourceId: DOCUMENT,
  sourceType: 'document',
};

describe('a context menu is the command registry read contextually', () => {
  it('[R01] offers only commands the registry has registered', () => {
    for (const commandId of menuCommandIds()) {
      expect(workbench.commands.has(commandId), `menu names unregistered ${commandId}`).toBe(true);
    }
  });

  it('[R01] takes every word it shows from the registries, never from the table', () => {
    const [group] = workbench.contextMenu('library-row', fileArgs);
    const item = group?.items[0];
    expect(item).toBeDefined();
    const command = workbench.commands.get(item?.commandId ?? '');
    expect(item?.title).toBe(command?.title);
    expect(item?.label).toBe(command?.label);
    expect(item?.category).toBe(command?.category);
    // And the chord beside it is the keybinding registry's, so a menu is also how a key is
    // learned — and cannot print one that has moved.
    const linkItem = workbench
      .contextMenu('library-row', fileArgs)
      .flatMap((each) => each.items)
      .find((each) => each.commandId === COMMAND_IDS.linkToDocument);
    expect(linkItem?.chords).toEqual(workbench.keybindings.chordsForCommand(COMMAND_IDS.linkToDocument));
  });

  it('[R01] hands the target’s own arguments to every item, so a menu acts on what was clicked', () => {
    const items = workbench.contextMenu('library-row', fileArgs).flatMap((group) => group.items);
    for (const item of items) expect(item.args).toEqual(fileArgs);
  });
});

describe('what a menu leaves out', () => {
  it('[R01] drops a command whose `when` clause does not hold here', () => {
    // Asserted against a registry of this test's own, because a `when` clause is a property of
    // whatever command table is loaded — including a user's — and not of the menu. A menu omits
    // what does not apply rather than greying it, which is what makes a short menu trustworthy.
    const registry = new CommandRegistry();
    const noop = (): void => {};
    registry.register({
      id: COMMAND_IDS.closeTab,
      title: 'Close Tab',
      category: 'View',
      when: 'annotationSelected',
      handler: noop,
    });
    registry.register({
      id: COMMAND_IDS.closeGroup,
      title: 'Close Group',
      category: 'View',
      handler: noop,
    });
    const args = { panelId: 'panel-1', groupId: 'group-1' };
    const lookup = { commands: registry, chordsFor: () => [] };

    expect(
      buildContextMenu('tab', args, { ...lookup, context: {} })
        .flatMap((group) => group.items)
        .map((item) => item.commandId),
    ).toEqual([COMMAND_IDS.closeGroup]);

    expect(
      buildContextMenu('tab', args, { ...lookup, context: { annotationSelected: true } })
        .flatMap((group) => group.items)
        .map((item) => item.commandId),
    ).toEqual([COMMAND_IDS.closeTab, COMMAND_IDS.closeGroup]);
  });

  it('[R01] drops what the target cannot supply an argument for', () => {
    // The help tab shows nothing that can be linked or sent anywhere, so its menu is the two
    // things you can do to a *panel* — and nothing has to know that "help" is special.
    const bare = idsOf('tab', { panelId: 'panel-1', groupId: 'group-1' });
    expect(bare).toEqual([COMMAND_IDS.closeTab, COMMAND_IDS.closeGroup]);

    // A tab on a file offers the rest of it.
    const onFile = idsOf('tab', { panelId: 'panel-1', groupId: 'group-1', ...fileArgs });
    expect(onFile).toContain(COMMAND_IDS.openLedger);
    expect(onFile).toContain(COMMAND_IDS.sendToNotebook);
  });

  it('[R01] drops what makes no sense for this kind of thing', () => {
    // Reading produces files and highlights, and those are the only two things a desk card can
    // be made of — so a note's node on the map can be linked but not sent.
    const onNote = idsOf('graph-node', {
      entityId: NOTE,
      entityType: 'note',
      sourceId: NOTE,
      sourceType: 'note',
    });
    expect(onNote).toContain(COMMAND_IDS.linkToDocument);
    expect(onNote).not.toContain(COMMAND_IDS.sendToNotebook);

    const onHighlight = idsOf('highlight', {
      entityId: ANNOTATION,
      entityType: 'annotation',
      documentId: DOCUMENT,
      sourceId: ANNOTATION,
      sourceType: 'annotation',
    });
    expect(onHighlight).toContain(COMMAND_IDS.sendToNotebook);
    // The ledger of the paper the sentence was marked in — the menu carries the file with it.
    expect(onHighlight).toContain(COMMAND_IDS.openLedger);
  });

  it('[R01] never offers deleting a notebook, which the discarded shelf guards', () => {
    const onNotebook = idsOf('notebook', { questionId: NOTEBOOK });
    expect(onNotebook).toEqual([
      COMMAND_IDS.openNotebook,
      COMMAND_IDS.openJournal,
      COMMAND_IDS.openNotebookDirectory,
    ]);
  });

  it('[R01] gives an empty answer rather than an empty menu', () => {
    expect(workbench.contextMenu('library-row', {})).toEqual([]);
  });
});

describe('the writing commands behind a block’s menu', () => {
  it('[R01] adds a block after the one that was right-clicked', async () => {
    const host = new SilentHost();
    const asked: BlockActionRequest[] = [];
    host.runBlockAction = (request) => {
      asked.push(request);
    };
    const bench = new Workbench(host, { platform: 'mac' });

    await bench.commands.execute(COMMAND_IDS.addTextBlock, {
      surfaceId: 'notebook:qst_1',
      blockIndex: 2,
    });
    await bench.commands.execute(COMMAND_IDS.addCodeBlock, { surfaceId: 'notebook:qst_1' });
    await bench.commands.execute(COMMAND_IDS.editBlock, {
      surfaceId: 'notebook:qst_1',
      blockIndex: 0,
    });

    expect(asked).toEqual([
      { action: 'add-text', surfaceId: 'notebook:qst_1', index: 2 },
      // No block under the pointer — the palette's copy of the same command — so it lands at
      // the end, the way `closePanel(null)` means the focused tab.
      { action: 'add-code', surfaceId: 'notebook:qst_1', index: null },
      { action: 'edit', surfaceId: 'notebook:qst_1', index: 0 },
    ]);
  });
});
