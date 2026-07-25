import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AnnotationId,
  DocumentId,
  Link,
  LinkId,
  NavigationLocation,
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
  type ReferenceQuery,
  type WorkbenchHost,
} from '../src/workbench.js';

const DOC = 'doc_01j0000000000000000000000a' as DocumentId;
const DOC_B = 'doc_01j0000000000000000000000b' as DocumentId;
const ANN = 'ann_01j0000000000000000000000c' as AnnotationId;

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
  readonly referenceSteps: number[] = [];
  readonly shownReferences: ReferenceQuery[] = [];
  /** What the workbench handed the panel to render, not merely what it asked for. */
  readonly shownResults: (readonly ResolvedLink[])[] = [];

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

  copyToClipboard(text: string): void {
    this.clipboard.push(text);
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
      depth: 1,
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
