import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AnnotationId,
  DocumentId,
  Link,
  LinkId,
  NavigationLocation,
  NoteId,
  ResolvedLink,
} from '@wr/shared-types';
import type { EntityRef } from '../src/entity-links.js';
import { CommandDisabledError, CommandNotFoundError } from '../src/commands.js';
import type { PanelDescriptor } from '../src/layout.js';
import {
  applyOpenPlan,
  emptyWorkspaceSnapshot,
  readerDescriptorFor,
  type OpenPlan,
  type WorkspaceSnapshot,
} from '../src/panel-targets.js';
import {
  COMMAND_IDS,
  DEFAULT_KEYBINDINGS,
  Workbench,
  type EntityLinkRequest,
  type ReferenceQuery,
  type WorkbenchHost,
} from '../src/workbench.js';

const DOC = 'doc_01j0000000000000000000000a' as DocumentId;
const DOC_B = 'doc_01j0000000000000000000000b' as DocumentId;
const ANN = 'ann_01j0000000000000000000000c' as AnnotationId;
const NOTE = 'not_01j0000000000000000000000d';

const NOW = '2026-07-25T00:00:00.000Z';

const annotationBelongsToDocument: Link = {
  id: 'lnk_01j000000000000000000000a1' as LinkId,
  type: 'annotation-belongs-to-document',
  sourceId: ANN,
  sourceType: 'annotation',
  targetId: DOC,
  targetType: 'document',
  sourceLocation: { kind: 'pdf', pageIndex: 12 },
  targetLocation: null,
  label: null,
  ordinal: null,
  origin: 'derived',
  generator: null,
  metadata: null,
  createdAt: NOW,
  updatedAt: NOW,
};

/**
 * Two resolved edges as the link repository hands them back: one pointing at the document,
 * one pointing away from it. `otherTitle` is what the references panel renders, so tests
 * assert on it to prove real reference data reached the panel rather than just the query.
 */
const incomingCitation: ResolvedLink = {
  id: 'lnk_01j000000000000000000000b1' as LinkId,
  type: 'document-cites-document',
  sourceId: DOC_B,
  sourceType: 'document',
  targetId: DOC,
  targetType: 'document',
  sourceLocation: null,
  targetLocation: null,
  label: null,
  ordinal: null,
  origin: 'manual',
  generator: null,
  metadata: null,
  createdAt: NOW,
  updatedAt: NOW,
  direction: 'incoming',
  otherTitle: 'Citing paper',
  otherType: 'document',
  otherDocumentId: DOC_B,
  excerpt: null,
  broken: false,
  otherLocation: null,
};

const outgoingCitation: ResolvedLink = {
  ...incomingCitation,
  id: 'lnk_01j000000000000000000000b2' as LinkId,
  sourceId: DOC,
  targetId: DOC_B,
  direction: 'outgoing',
  otherTitle: 'Cited paper',
};

/** A host that records what the workbench asked it to do. */
class FakeHost implements WorkbenchHost {
  workspace: WorkspaceSnapshot = emptyWorkspaceSnapshot();
  activeEntity: EntityRef | null = null;
  linkUnderCursor: EntityRef | null = null;
  links: Link[] = [];
  resolved: ResolvedLink[] = [];
  navigationLocation: NavigationLocation | null = null;

  readonly plans: OpenPlan[] = [];
  readonly clipboard: string[] = [];
  readonly peeked: EntityRef[] = [];
  readonly revealed: EntityRef[] = [];
  readonly sidebarToggles: string[] = [];
  readonly closedPanels: (string | null)[] = [];
  readonly closedGroups: (string | null)[] = [];
  readonly referenceSteps: number[] = [];
  readonly shownReferences: ReferenceQuery[] = [];
  /** What the workbench handed the panel to render, not merely what it asked for. */
  readonly shownResults: (readonly ResolvedLink[])[] = [];
  readonly commandListOpen: boolean[] = [];
  readonly fileListOpen: boolean[] = [];
  /** What `notebookInHand` answers — the keyboard's notebook, when a command is given none. */
  notebook: string | null = null;
  readonly linkPrompts: EntityRef[] = [];
  readonly documentLinks: EntityLinkRequest[] = [];
  readonly noteSources: EntityRef[] = [];
  nextNoteId: string | null = NOTE;

  getWorkspace(): WorkspaceSnapshot {
    return this.workspace;
  }

  applyPlan(plan: OpenPlan): void {
    this.plans.push(plan);
    this.workspace = applyOpenPlan(this.workspace, plan);
  }

  getActiveEntity(): EntityRef | null {
    return this.activeEntity;
  }

  getLinkUnderCursor(): EntityRef | null {
    return this.linkUnderCursor;
  }

  describeEntity(entity: EntityRef): PanelDescriptor | null {
    if (entity.entityType === 'document') {
      return readerDescriptorFor(entity.entityId as DocumentId, 'pdf', entity.location ?? null);
    }
    if (entity.entityType === 'annotation') {
      return {
        kind: 'annotation-list',
        documentId: entity.documentId ?? null,
        selectedAnnotationId: entity.entityId as AnnotationId,
      };
    }
    if (entity.entityType === 'note') {
      return { kind: 'note-editor', noteId: entity.entityId as NoteId };
    }
    return null;
  }

  getLinks(): readonly Link[] {
    return this.links;
  }

  resolveLinks(): readonly ResolvedLink[] {
    return this.resolved;
  }

  showReferences(query: ReferenceQuery, results: readonly ResolvedLink[]): void {
    this.shownReferences.push(query);
    this.shownResults.push(results);
  }

  stepReference(delta: 1 | -1): void {
    this.referenceSteps.push(delta);
  }

  showPeek(entity: EntityRef): void {
    this.peeked.push(entity);
  }

  revealInLibrary(entity: EntityRef): void {
    this.revealed.push(entity);
  }

  toggleSidebar(which: 'library' | 'annotations' | 'bottomPanel'): void {
    this.sidebarToggles.push(which);
  }

  closePanel(panelId: string | null): void {
    this.closedPanels.push(panelId);
  }

  closeGroup(groupId: string | null): void {
    this.closedGroups.push(groupId);
  }

  copyToClipboard(text: string): void {
    this.clipboard.push(text);
  }

  showCommands(open: boolean): void {
    this.commandListOpen.push(open);
  }

  showFiles(open: boolean): void {
    this.fileListOpen.push(open);
  }

  notebookInHand(): Promise<string | null> {
    return Promise.resolve(this.notebook);
  }

  promptEntityLink(source: EntityRef): void {
    this.linkPrompts.push(source);
  }

  createEntityLink(request: EntityLinkRequest): Promise<Link | null> {
    this.documentLinks.push(request);
    return Promise.resolve({
      ...incomingCitation,
      type: request.type,
      sourceType: request.source.entityType,
      sourceId: request.source.entityId,
      targetType: request.target.entityType,
      targetId: request.target.entityId,
    });
  }

  createNoteFrom(entity: EntityRef): Promise<string | null> {
    this.noteSources.push(entity);
    return Promise.resolve(this.nextNoteId);
  }

  currentNavigationLocation(): NavigationLocation | null {
    return this.navigationLocation;
  }
}

let host: FakeHost;
let workbench: Workbench;

beforeEach(() => {
  host = new FakeHost();
  workbench = new Workbench(host, { platform: 'mac' });
});

describe('the workbench command surface', () => {
  it('[L09] registers every navigation command the spec requires', () => {
    for (const id of Object.values(COMMAND_IDS)) {
      expect(workbench.commands.has(id), `missing command ${id}`).toBe(true);
    }
  });

  it('[L09] binds every default keybinding to a registered command', () => {
    for (const rule of DEFAULT_KEYBINDINGS) {
      expect(workbench.commands.has(rule.commandId), `unbound ${rule.commandId}`).toBe(true);
    }
  });

  /**
   * The scheme, asserted as a scheme rather than as a list of chords.
   *
   * A test that named each key would be the hand-written sheet the criteria forbid, one file
   * over. These say the *properties* that make it learnable: every page is on the same
   * modifiers, no two commands share a chord, and nothing in that family is gated on a context
   * that would make it silently do nothing.
   */
  describe('the keyboard scheme', () => {
    const chordFor = (commandId: string): string[] =>
      workbench.keybindings.chordsForCommand(commandId);

    it('puts every page of the workspace on the same modifiers', () => {
      const pages = [
        COMMAND_IDS.openNotebookDirectory,
        COMMAND_IDS.openNotebook,
        COMMAND_IDS.openJournal,
        COMMAND_IDS.openReading,
        COMMAND_IDS.openWiki,
        COMMAND_IDS.openFocusView,
        COMMAND_IDS.openLedger,
        COMMAND_IDS.openLinkGraph,
        COMMAND_IDS.openHelp,
        COMMAND_IDS.openSearch,
        COMMAND_IDS.showCommands,
      ];
      for (const page of pages) {
        const chords = chordFor(page);
        expect(chords.length, `no key opens ${page}`).toBeGreaterThan(0);
        expect(
          chords.some((chord) => chord.startsWith('shift+meta+')),
          `${page} is not in the go-to-a-page family: ${chords.join(', ')}`,
        ).toBe(true);
      }

      // One letter per page, or the family is a collision rather than a scheme.
      const letters = pages.flatMap((page) =>
        chordFor(page).filter((chord) => chord.startsWith('shift+meta+')),
      );
      expect(new Set(letters).size).toBe(letters.length);
    });

    it('leaves the page family ungated, so it works from inside a note', async () => {
      const inANote = { textInputFocus: true };
      for (const binding of workbench.keybindings.all()) {
        if (!binding.chord.startsWith('shift+meta+')) continue;
        expect(binding.when, `${binding.commandId} is gated on ${binding.when?.source ?? ''}`).toBe(
          null,
        );
      }
      // And the resolution agrees, not only the table.
      const match = workbench.keybindings.resolve(
        { key: 'd', ctrl: false, shift: true, alt: false, meta: true },
        inANote,
      );
      expect(match?.commandId).toBe(COMMAND_IDS.openNotebookDirectory);
      await Promise.resolve();
    });

    it('gives no chord two meanings', () => {
      const byChord = new Map<string, Set<string>>();
      for (const binding of workbench.keybindings.all()) {
        const seen = byChord.get(binding.chord) ?? new Set<string>();
        seen.add(binding.commandId);
        byChord.set(binding.chord, seen);
      }
      for (const [chord, commandIds] of byChord) {
        expect([...commandIds], `${chord} runs more than one command`).toHaveLength(1);
      }
    });

    it('reports every binding it holds, so the help page can render them all', () => {
      const all = workbench.keybindings.all();
      expect(all).toHaveLength(DEFAULT_KEYBINDINGS.length);
      for (const rule of DEFAULT_KEYBINDINGS) {
        expect(
          all.some((binding) => binding.commandId === rule.commandId),
          `${rule.commandId} is missing from all()`,
        ).toBe(true);
      }
    });
  });

  it('opens the notebook in hand when a keystroke supplies none', async () => {
    host.notebook = 'que_from_the_host';

    await workbench.commands.execute(COMMAND_IDS.openNotebook, {});
    await workbench.commands.execute(COMMAND_IDS.openJournal, {});

    expect(host.plans).toHaveLength(2);
    expect(host.plans[0]?.descriptor).toEqual({ kind: 'notebook', questionId: 'que_from_the_host' });
    expect(host.plans[1]?.descriptor).toEqual({ kind: 'journal', questionId: 'que_from_the_host' });
  });

  it('says what would make it work when there is no notebook at all', async () => {
    host.notebook = null;
    await expect(workbench.commands.execute(COMMAND_IDS.openJournal, {})).rejects.toThrow(
      /make one in the directory/i,
    );
    expect(host.plans).toHaveLength(0);
  });

  it('asks the host for the list of files rather than opening one blind', async () => {
    await workbench.commands.execute(COMMAND_IDS.goToFile, {});
    expect(host.fileListOpen).toEqual([true]);
    expect(host.plans).toHaveLength(0);
  });

  it('goes back to what was being read, ignoring whatever the pointer is over', async () => {
    host.activeEntity = { entityId: DOC, entityType: 'document', documentId: DOC };
    host.linkUnderCursor = { entityId: DOC_B, entityType: 'document', documentId: DOC_B };

    await workbench.commands.execute(COMMAND_IDS.openReading, {});

    expect(host.plans).toHaveLength(1);
    const descriptor = host.plans[0]?.action === 'reveal' ? null : host.plans[0]?.descriptor;
    expect(descriptor).toMatchObject({ documentId: DOC });
  });

  it('[L09] routes a keystroke through the registry to the command', async () => {
    host.activeEntity = { entityId: DOC, entityType: 'document', documentId: DOC };

    const ran = await workbench.handleKeyDown({
      key: 'F12',
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      metaKey: false,
    });

    expect(ran).toBe(COMMAND_IDS.findAllReferences);
    expect(host.shownReferences).toHaveLength(1);
    expect(host.shownReferences[0]?.direction).toBe('both');
  });

  it('[U01] claims Cmd+W for the tab even when there is nothing open', async () => {
    const press = async (): Promise<string | null> =>
      workbench.handleKeyDown({
        key: 'w',
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: true,
      });

    expect(await press()).toBe(COMMAND_IDS.closeTab);
    expect(host.closedPanels).toEqual([null]);

    // The empty workspace is the case that matters. A binding that stopped matching here
    // would return null, the shell would not call preventDefault, and Chromium would close
    // the window — which is the whole defect. It still matches, and still closes nothing.
    host.workspace = emptyWorkspaceSnapshot();
    expect(await press()).toBe(COMMAND_IDS.closeTab);
    expect(host.plans).toEqual([]);
  });

  it('[U02] closes every tab in one group, so a split can be undone in one action', async () => {
    const ran = await workbench.handleKeyDown({
      key: 'w',
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      metaKey: true,
    });

    expect(ran).toBe(COMMAND_IDS.closeGroup);
    expect(host.closedGroups).toEqual([null]);
  });

  it('[L09] leaves an unbound keystroke alone', async () => {
    const ran = await workbench.handleKeyDown({
      key: 'q',
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
    });
    expect(ran).toBeNull();
  });

  it('[L09] does not fire Go to Parent while typing in a note', async () => {
    host.activeEntity = { entityId: ANN, entityType: 'annotation', documentId: DOC };
    host.links = [annotationBelongsToDocument];
    workbench.contextKeys.setMany({ canGoToParent: true, textInputFocus: true });

    const ran = await workbench.handleKeyDown({
      key: 'ArrowUp',
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: true,
    });

    expect(ran).toBeNull();
    expect(host.plans).toEqual([]);
  });

  it('[L09] fires Go to Parent when the note editor does not have focus', async () => {
    host.activeEntity = { entityId: ANN, entityType: 'annotation', documentId: DOC };
    host.links = [annotationBelongsToDocument];
    workbench.contextKeys.set('canGoToParent', true);

    const ran = await workbench.handleKeyDown({
      key: 'ArrowUp',
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: true,
    });

    expect(ran).toBe(COMMAND_IDS.goToParent);
  });

  it('[L09] surfaces an unknown command as an error rather than a silent no-op', async () => {
    // Everything a panel or a keystroke can trigger goes through the registry, so a command
    // id that is not registered has to be loud: the alternative is a button that does
    // nothing and reports nothing, which is the failure this registry exists to prevent.
    await expect(workbench.commands.execute('wr.noSuchCommand')).rejects.toBeInstanceOf(
      CommandNotFoundError,
    );
  });

  it('[L09] opens the link graph on the entity in hand, through the registry', async () => {
    host.activeEntity = { entityId: DOC, entityType: 'document', documentId: DOC };

    await workbench.commands.execute(COMMAND_IDS.openLinkGraph, {}, workbench.context());

    const plan = host.plans.at(-1);
    expect(plan?.action).not.toBe('reveal');
    const descriptor = plan !== undefined && plan.action !== 'reveal' ? plan.descriptor : null;
    expect(descriptor).toEqual({
      kind: 'link-graph',
      seedEntityId: DOC,
      seedEntityType: 'document',
    });
  });

  it('[L09] finds commands in the palette by intent', () => {
    const results = workbench.searchCommands('who links here');
    expect(results[0]?.command.id).toBe(COMMAND_IDS.findAllReferences);
  });

  it('[L09] accepts user keybinding overrides on top of the defaults', async () => {
    const errors = workbench.loadUserKeybindings([
      { commandId: COMMAND_IDS.revealInLibrary, key: 'f9' },
    ]);
    expect(errors).toEqual([]);

    host.activeEntity = { entityId: DOC, entityType: 'document', documentId: DOC };
    const ran = await workbench.handleKeyDown({
      key: 'F9',
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
    });

    expect(ran).toBe(COMMAND_IDS.revealInLibrary);
    expect(host.revealed[0]?.entityId).toBe(DOC);
  });
});

describe('opening in the current pane and to the side', () => {
  it('[L07] opens a document in the active pane', async () => {
    await workbench.commands.execute(COMMAND_IDS.openDocument, {
      entityId: DOC,
      entityType: 'document',
    });

    expect(host.plans).toHaveLength(1);
    expect(host.plans[0]?.action).toBe('open');
    expect(host.workspace.panels).toHaveLength(1);
    expect(host.workspace.groupIds).toHaveLength(1);
  });

  it('[L07] opens a second document to the side, producing two groups', async () => {
    await workbench.commands.execute(COMMAND_IDS.openDocument, {
      entityId: DOC,
      entityType: 'document',
    });
    await workbench.commands.execute(COMMAND_IDS.openToSide, {
      entityId: DOC_B,
      entityType: 'document',
    });

    expect(host.workspace.groupIds).toHaveLength(2);
    expect(host.workspace.panels).toHaveLength(2);
    expect(new Set(host.workspace.panels.map((panel) => panel.groupId)).size).toBe(2);
  });

  it('[L07] reuses the pane when the same document is opened again', async () => {
    const args = { entityId: DOC, entityType: 'document' };
    await workbench.commands.execute(COMMAND_IDS.openDocument, args);
    await workbench.commands.execute(COMMAND_IDS.openDocument, args);

    expect(host.plans.map((plan) => plan.action)).toEqual(['open', 'reveal']);
    expect(host.workspace.panels).toHaveLength(1);
  });

  it('[L07] acts on the link under the cursor when no entity is passed', async () => {
    host.linkUnderCursor = { entityId: DOC, entityType: 'document', documentId: DOC };
    workbench.contextKeys.set('linkUnderCursor', true);

    await workbench.commands.execute(
      COMMAND_IDS.goToTarget,
      {},
      workbench.context(),
    );

    expect(host.plans).toHaveLength(1);
    expect(host.workspace.panels[0]?.descriptor).toMatchObject({ kind: 'pdf-reader', documentId: DOC });
  });

  it('[L07] refuses Go to Target when nothing is selected or under the cursor', async () => {
    await expect(
      workbench.commands.execute(COMMAND_IDS.goToTarget, {}, workbench.context()),
    ).rejects.toBeInstanceOf(CommandDisabledError);
  });
});

describe('go to parent through the command layer', () => {
  it('[L05] opens the parent document of the selected annotation at its page', async () => {
    host.activeEntity = { entityId: ANN, entityType: 'annotation', documentId: DOC };
    host.links = [annotationBelongsToDocument];

    await workbench.commands.execute(COMMAND_IDS.goToParent, {});

    expect(host.plans).toHaveLength(1);
    const plan = host.plans[0];
    expect(plan?.action).toBe('open');
    if (plan === undefined || plan.action !== 'open') return;
    expect(plan.descriptor).toMatchObject({ kind: 'pdf-reader', documentId: DOC });
    expect(plan.location).toEqual({ kind: 'pdf', pageIndex: 12 });
  });

  it('[L05] sets canGoToParent from the actual link data', async () => {
    host.activeEntity = { entityId: ANN, entityType: 'annotation', documentId: DOC };
    host.links = [annotationBelongsToDocument];
    await workbench.refreshDerivedContext();
    expect(workbench.contextKeys.get('canGoToParent')).toBe(true);

    host.links = [];
    await workbench.refreshDerivedContext();
    expect(workbench.contextKeys.get('canGoToParent')).toBe(false);
  });

  it('[L05] does nothing when the entity has no parent', async () => {
    host.activeEntity = { entityId: DOC, entityType: 'document', documentId: DOC };
    host.links = [];
    await expect(workbench.commands.execute(COMMAND_IDS.goToParent, {})).resolves.toBeNull();
    expect(host.plans).toEqual([]);
  });
});

describe('navigation history', () => {
  it('[L06] records where the user was before navigating away', async () => {
    host.navigationLocation = {
      entityId: DOC,
      entityType: 'document',
      documentId: DOC,
      location: { kind: 'pdf', pageIndex: 4 },
      timestamp: 1,
    };

    await workbench.commands.execute(COMMAND_IDS.openDocument, {
      entityId: DOC_B,
      entityType: 'document',
    });

    expect(workbench.history.size).toBe(1);
    expect(workbench.contextKeys.get('canGoBack')).toBe(false); // one entry: nowhere back to yet

    host.navigationLocation = {
      entityId: DOC_B,
      entityType: 'document',
      documentId: DOC_B,
      timestamp: 2,
    };
    await workbench.commands.execute(COMMAND_IDS.openDocument, {
      entityId: DOC,
      entityType: 'document',
    });

    expect(workbench.history.size).toBe(2);
    expect(workbench.contextKeys.get('canGoBack')).toBe(true);
  });

  it('[L06] Go Back restores the previous location and updates the context keys', async () => {
    host.navigationLocation = {
      entityId: DOC,
      entityType: 'document',
      documentId: DOC,
      location: { kind: 'pdf', pageIndex: 4 },
      timestamp: 1,
    };
    await workbench.commands.execute(COMMAND_IDS.openDocument, {
      entityId: DOC_B,
      entityType: 'document',
    });
    host.navigationLocation = {
      entityId: DOC_B,
      entityType: 'document',
      documentId: DOC_B,
      timestamp: 2,
    };
    await workbench.commands.execute(COMMAND_IDS.openDocument, {
      entityId: DOC,
      entityType: 'document',
    });

    const before = host.plans.length;
    await workbench.commands.execute(COMMAND_IDS.goBack, {}, workbench.context());

    expect(host.plans.length).toBe(before + 1);
    const plan = host.plans[host.plans.length - 1];
    expect(plan?.action).toBe('reveal');
    expect(workbench.contextKeys.get('canGoForward')).toBe(true);
  });

  it('[L06] Go Back is disabled when there is nowhere to go', async () => {
    await expect(
      workbench.commands.execute(COMMAND_IDS.goBack, {}, workbench.context()),
    ).rejects.toBeInstanceOf(CommandDisabledError);
  });
});

describe('link commands', () => {
  it('[L01] copies the internal link for the selected entity', async () => {
    host.activeEntity = { entityId: DOC, entityType: 'document', documentId: DOC };
    const copied = await workbench.commands.execute(COMMAND_IDS.copyInternalLink, {});
    expect(copied).toBe(`document://${DOC}`);
    expect(host.clipboard).toEqual([`document://${DOC}`]);
  });

  it('[L03] Shift+F12 lists the references the store returns for the active entity', async () => {
    host.activeEntity = { entityId: DOC, entityType: 'document', documentId: DOC };
    host.resolved = [incomingCitation, outgoingCitation];

    // The criterion names Shift+F12, so the binding is resolved rather than the command
    // called by name — a rebinding that orphaned this command would otherwise pass.
    const binding = DEFAULT_KEYBINDINGS.find((rule) => rule.key === 'shift+f12');
    expect(binding?.commandId).toBe(COMMAND_IDS.findAllReferences);
    await workbench.commands.execute(binding?.commandId ?? '', {});

    expect(host.shownReferences).toHaveLength(1);
    expect(host.shownReferences[0]?.direction).toBe('both');
    expect(host.shownReferences[0]?.entity.entityId).toBe(DOC);
    // What the panel was handed, not what it was asked for: a store returning nothing must
    // not be able to leave this test green.
    expect(host.shownResults[0]?.map((link) => link.otherTitle)).toEqual([
      'Citing paper',
      'Cited paper',
    ]);
  });

  it('[L03] asks for one direction at a time when the directional commands are used', async () => {
    host.activeEntity = { entityId: DOC, entityType: 'document', documentId: DOC };
    host.resolved = [incomingCitation];

    await workbench.commands.execute(COMMAND_IDS.findIncomingLinks, {});
    await workbench.commands.execute(COMMAND_IDS.findOutgoingLinks, {});

    expect(host.shownReferences.map((query) => query.direction)).toEqual(['incoming', 'outgoing']);
    expect(host.shownResults[0]).toEqual([incomingCitation]);
  });

  it('[L04] lists links of one type, narrowed by the requested link type', async () => {
    host.activeEntity = { entityId: DOC, entityType: 'document', documentId: DOC };
    host.resolved = [outgoingCitation];

    await workbench.commands.execute(COMMAND_IDS.findAllLinksOfType, {
      linkType: 'document-cites-document',
    });

    expect(host.shownReferences[0]?.linkType).toBe('document-cites-document');
    expect(host.shownResults[0]).toEqual([outgoingCitation]);
  });

  it('[L04] requires a link type rather than silently listing everything', async () => {
    host.activeEntity = { entityId: DOC, entityType: 'document', documentId: DOC };
    await expect(workbench.commands.execute(COMMAND_IDS.findAllLinksOfType, {})).rejects.toThrow(
      /requires a `linkType`/,
    );
  });

  it('[L08] stepping through references does not close the references panel', async () => {
    host.activeEntity = { entityId: DOC, entityType: 'document', documentId: DOC };
    await workbench.commands.execute(COMMAND_IDS.findAllReferences, {});

    await workbench.commands.execute(COMMAND_IDS.goToNextReference, {});
    await workbench.commands.execute(COMMAND_IDS.goToPreviousReference, {});

    expect(host.referenceSteps).toEqual([1, -1]);
    // Navigating results never re-issues a showReferences, so the panel stays as it was.
    expect(host.shownReferences).toHaveLength(1);
  });

  it('[L09] peek previews the target without opening a panel', async () => {
    host.linkUnderCursor = { entityId: DOC, entityType: 'document', documentId: DOC };
    workbench.contextKeys.set('linkUnderCursor', true);

    await workbench.commands.execute(COMMAND_IDS.peekDefinition, {}, workbench.context());

    expect(host.peeked).toHaveLength(1);
    expect(host.plans).toEqual([]);
  });

  it('[L09] toggles the sidebars through commands, not direct panel calls', async () => {
    await workbench.commands.execute(COMMAND_IDS.toggleLibrarySidebar, {});
    await workbench.commands.execute(COMMAND_IDS.toggleAnnotationSidebar, {});
    expect(host.sidebarToggles).toEqual(['library', 'annotations']);
  });

  it('[L09] opens the search panel with the requested query', async () => {
    await workbench.commands.execute(COMMAND_IDS.openSearch, { query: 'transformer' });

    const plan = host.plans[0];
    expect(plan?.action).toBe('open');
    if (plan === undefined || plan.action !== 'open') return;
    expect(plan.descriptor).toMatchObject({ kind: 'search-results', query: 'transformer' });
  });
});

describe('context key maintenance', () => {
  it('[L09] derives selection context keys from the host', async () => {
    host.activeEntity = { entityId: ANN, entityType: 'annotation', documentId: DOC };
    host.linkUnderCursor = null;
    host.links = [annotationBelongsToDocument];

    await workbench.refreshDerivedContext();

    expect(workbench.contextKeys.get('annotationSelected')).toBe(true);
    expect(workbench.contextKeys.get('documentSelected')).toBe(false);
    expect(workbench.contextKeys.get('linkUnderCursor')).toBe(false);
  });

  it('[L09] notifies subscribers when context changes', async () => {
    const listener = vi.fn();
    workbench.contextKeys.onDidChange(listener);
    host.activeEntity = { entityId: DOC, entityType: 'document', documentId: DOC };

    await workbench.refreshDerivedContext();

    expect(listener).toHaveBeenCalled();
  });
});

describe('linking and note-taking from where the reader is', () => {
  it('[L09] links from the document being read, not from whatever the pointer is over', async () => {
    // Reading A, hovering a chip that points at B. The link has to come from A: reaching for
    // the menu across a citation must not silently swap which paper the edge starts at.
    host.activeEntity = { entityId: DOC, entityType: 'document', documentId: DOC };
    host.linkUnderCursor = { entityId: DOC_B, entityType: 'document', documentId: DOC_B };

    await workbench.commands.execute(COMMAND_IDS.linkToDocument, {}, workbench.context());

    expect(host.linkPrompts).toEqual([
      { entityId: DOC, entityType: 'document', documentId: DOC },
    ]);
  });

  it('[H02] keeps a selected highlight as the end the link is made from', async () => {
    // This used to collapse to the paper, which made a highlight the one thing in the app
    // that could be linked *to* and never linked *from*.
    host.activeEntity = { entityId: ANN, entityType: 'annotation', documentId: DOC };

    await workbench.commands.execute(COMMAND_IDS.linkToDocument, {}, workbench.context());

    expect(host.linkPrompts).toEqual([
      { entityId: ANN, entityType: 'annotation', documentId: DOC },
    ]);
  });

  it('[H02] links from the file when the caller asks for the file', async () => {
    // The reader's own strip names the paper it sits above, which is what makes "link this
    // paper" reachable while a highlight in it happens to be selected.
    host.activeEntity = { entityId: ANN, entityType: 'annotation', documentId: DOC };

    await workbench.commands.execute(
      COMMAND_IDS.linkToDocument,
      { sourceId: DOC, sourceType: 'document' },
      workbench.context(),
    );

    expect(host.linkPrompts).toEqual([{ entityId: DOC, entityType: 'document' }]);
  });

  it('[L09] refuses to write a document link with no relationship chosen', async () => {
    host.activeEntity = { entityId: DOC, entityType: 'document', documentId: DOC };

    await expect(
      workbench.commands.execute(
        COMMAND_IDS.createDocumentLink,
        { targetId: DOC_B },
        workbench.context(),
      ),
    ).rejects.toThrow(/relationship/i);
    // Nothing was written. A default type here would be a claim the researcher never made.
    expect(host.documentLinks).toEqual([]);
  });

  it('[L09] writes the chosen relationship between the two documents', async () => {
    host.activeEntity = { entityId: DOC, entityType: 'document', documentId: DOC };

    await workbench.commands.execute(
      COMMAND_IDS.createDocumentLink,
      { targetId: DOC_B, linkType: 'related-to' },
      workbench.context(),
    );

    expect(host.documentLinks).toEqual([
      {
        source: { entityId: DOC, entityType: 'document', documentId: DOC },
        target: { entityId: DOC_B, entityType: 'document' },
        type: 'related-to',
      },
    ]);
  });

  it('[H02] writes an edge from a highlight to a whole file', async () => {
    host.activeEntity = { entityId: ANN, entityType: 'annotation', documentId: DOC };

    await workbench.commands.execute(
      COMMAND_IDS.createDocumentLink,
      { targetId: DOC_B, targetType: 'document', linkType: 'annotation-references-document' },
      workbench.context(),
    );

    expect(host.documentLinks).toEqual([
      {
        source: { entityId: ANN, entityType: 'annotation', documentId: DOC },
        target: { entityId: DOC_B, entityType: 'document' },
        type: 'annotation-references-document',
      },
    ]);
  });

  it('[H02] refuses a relationship that pair of ends cannot carry', async () => {
    host.activeEntity = { entityId: ANN, entityType: 'annotation', documentId: DOC };

    // The containment edge every highlight already carries to its own paper. Offering it as a
    // *choice* would mean an assertion the researcher made came back as the automatic one.
    await expect(
      workbench.commands.execute(
        COMMAND_IDS.createDocumentLink,
        { targetId: DOC_B, targetType: 'document', linkType: 'annotation-belongs-to-document' },
        workbench.context(),
      ),
    ).rejects.toThrow(/not a relationship/i);
    expect(host.documentLinks).toEqual([]);
  });

  it('[L09] refuses to link a document to itself', async () => {
    host.activeEntity = { entityId: DOC, entityType: 'document', documentId: DOC };

    await expect(
      workbench.commands.execute(
        COMMAND_IDS.createDocumentLink,
        { targetId: DOC, linkType: 'related-to' },
        workbench.context(),
      ),
    ).rejects.toThrow(/itself/i);
    expect(host.documentLinks).toEqual([]);
  });

  it('[L09] makes a note from the selected highlight rather than from its document', async () => {
    host.activeEntity = { entityId: ANN, entityType: 'annotation', documentId: DOC };

    await workbench.commands.execute(COMMAND_IDS.newNoteFromHere, {}, workbench.context());

    expect(host.noteSources).toEqual([
      { entityId: ANN, entityType: 'annotation', documentId: DOC },
    ]);
    // And the note it made is what opened, beside the reader.
    const plan = host.plans.at(-1);
    expect(plan?.action).toBe('split');
    expect(plan?.action === 'open' || plan?.action === 'split' ? plan.descriptor : null).toMatchObject({
      kind: 'note-editor',
      noteId: NOTE,
    });
  });

  it('[L09] falls back to the open document when no highlight is selected', async () => {
    host.activeEntity = { entityId: DOC, entityType: 'document', documentId: DOC };

    await workbench.commands.execute(COMMAND_IDS.newNoteFromHere, {}, workbench.context());

    expect(host.noteSources).toEqual([{ entityId: DOC, entityType: 'document', documentId: DOC }]);
  });

  it('[L09] says what would make a note possible when there is nothing to make one from', async () => {
    host.activeEntity = null;

    await expect(
      workbench.commands.execute(COMMAND_IDS.newNoteFromHere, {}, workbench.context()),
    ).rejects.toThrow(/Open a document or select a highlight/);
  });
});
