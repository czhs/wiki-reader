/**
 * `WorkbenchHost` over Dockview and the IPC bridge.
 *
 * `@wr/workbench` decides *what* should happen — which panel a navigation lands in, which
 * links a reference query covers, what the history contains — and hands down a plan. This
 * module is the only place that plan meets a real workspace. Keeping the split means the
 * interesting rules stay testable in plain Node, and this file stays mechanical.
 */
import { anchorToLocation } from '@wr/document-model';
import {
  DocumentIdSchema,
  NoteIdSchema,
  type DocumentLocation,
  type Link,
  type NavigationLocation,
  type ResolvedLink,
} from '@wr/shared-types';
import {
  readerDescriptorFor,
  resolveOpen,
  type EntityRef,
  type OpenPlan,
  type PanelDescriptor,
  type PanelKind,
  type ReferenceQuery,
  type WorkbenchHost,
  type WorkspaceSnapshot,
} from '@wr/workbench';
import { call, describeError } from './ipc.js';
import type { WorkspaceStore } from './store.js';

/** Dockview component names are the panel kinds; the shell registers one per kind. */
export function componentFor(kind: PanelKind): string {
  return kind;
}

export function titleFor(
  descriptor: PanelDescriptor,
  documentTitles: Readonly<Record<string, string>>,
): string {
  switch (descriptor.kind) {
    case 'library':
      return 'Library';
    case 'pdf-reader':
    case 'article-reader':
      return documentTitles[descriptor.documentId] ?? 'Document';
    case 'search-results':
      return 'Search';
    case 'annotation-list':
      return 'Annotations';
    case 'note-editor':
      return 'Note';
    case 'document-outline':
      return 'Outline';
    case 'backlinks':
      return 'Backlinks';
    case 'references':
      return 'References';
    case 'link-results':
      return 'Links';
  }
}

/** The entity a resolved link points *away* from the queried one. */
export function otherEndpointRef(link: ResolvedLink): EntityRef {
  const isOutgoing = link.direction === 'outgoing';
  const entityId = isOutgoing ? link.targetId : link.sourceId;
  const entityType = isOutgoing ? link.targetType : link.sourceType;
  return {
    entityId,
    entityType,
    ...(link.otherDocumentId === null ? {} : { documentId: link.otherDocumentId }),
    ...(link.otherLocation === null ? {} : { location: link.otherLocation }),
  };
}

function referencesTitle(query: ReferenceQuery, count: number): string {
  const scope =
    query.linkType === undefined
      ? `${query.direction} references`
      : `links of type ${query.linkType}`;
  return `${String(count)} ${scope}`;
}

export interface HostCallbacks {
  /** Called when a plan lands in a panel, so the shell can move DOM focus there. */
  readonly onFocusPanel?: (panelId: string) => void;
}

export class DockviewWorkbenchHost implements WorkbenchHost {
  readonly #store: WorkspaceStore;
  readonly #callbacks: HostCallbacks;

  constructor(store: WorkspaceStore, callbacks: HostCallbacks = {}) {
    this.#store = store;
    this.#callbacks = callbacks;
  }

  // --- workspace shape ------------------------------------------------------

  getWorkspace(): WorkspaceSnapshot {
    const api = this.#store.api;
    const state = this.#store.getSnapshot();
    if (api === null) {
      return { panels: [], groupIds: [], activeGroupId: null, activePanelId: null };
    }

    const panels = api.panels.flatMap((panel) => {
      const descriptor = state.panels[panel.id];
      // A Dockview panel with no descriptor is one we have not finished registering.
      // Reporting it would let target resolution reuse a panel that shows nothing.
      return descriptor === undefined
        ? []
        : [{ panelId: panel.id, groupId: panel.group.id, descriptor }];
    });

    return {
      panels,
      groupIds: api.groups.map((group) => group.id),
      activeGroupId: api.activeGroup?.id ?? null,
      activePanelId: api.activePanel?.id ?? null,
    };
  }

  applyPlan(plan: OpenPlan): void {
    const api = this.#store.api;
    if (api === null) return;

    if (plan.action === 'reveal') {
      const panel = api.getPanel(plan.panelId);
      if (panel === undefined) return;
      if (plan.focus) {
        panel.api.setActive();
        this.#callbacks.onFocusPanel?.(plan.panelId);
      }
      if (plan.location !== null) this.#store.requestReveal(plan.panelId, plan.location);
      this.#syncSelectionFrom(plan.panelId);
      return;
    }

    // The descriptor has to exist before Dockview mounts the component, or the panel's
    // first render has nothing to show and has to flash an empty state.
    this.#store.setPanel(plan.panelId, plan.descriptor);
    if (plan.location !== null) this.#store.requestReveal(plan.panelId, plan.location);

    const titles = this.#store.getSnapshot().documentTitles;
    api.addPanel({
      id: plan.panelId,
      component: componentFor(plan.descriptor.kind),
      title: titleFor(plan.descriptor, titles),
      params: { panelId: plan.panelId },
      inactive: !plan.focus,
      position:
        plan.action === 'split'
          ? plan.referenceGroupId === null
            ? { direction: 'right' }
            : { referenceGroup: plan.referenceGroupId, direction: 'right' }
          : { referenceGroup: plan.groupId },
    });

    if (plan.focus) this.#callbacks.onFocusPanel?.(plan.panelId);
    this.#syncSelectionFrom(plan.panelId);
  }

  /** Keep the library highlight and annotation sidebar pointed at whatever just opened. */
  #syncSelectionFrom(panelId: string): void {
    const descriptor = this.#store.panel(panelId);
    if (descriptor === null) return;
    if (descriptor.kind === 'pdf-reader' || descriptor.kind === 'article-reader') {
      this.#store.update({ selectedDocumentId: descriptor.documentId, activePanelId: panelId });
    } else {
      this.#store.update({ activePanelId: panelId });
    }
  }

  // --- what the user is on --------------------------------------------------

  getActiveEntity(): EntityRef | null {
    const state = this.#store.getSnapshot();
    if (state.selectedAnnotationId !== null) {
      return {
        entityId: state.selectedAnnotationId,
        entityType: 'annotation',
        ...(state.selectedDocumentId === null ? {} : { documentId: state.selectedDocumentId }),
      };
    }

    const descriptor = state.activePanelId === null ? null : state.panels[state.activePanelId];
    if (descriptor !== undefined && descriptor !== null) {
      if (descriptor.kind === 'pdf-reader' || descriptor.kind === 'article-reader') {
        return {
          entityId: descriptor.documentId,
          entityType: 'document',
          documentId: descriptor.documentId,
        };
      }
      if (descriptor.kind === 'note-editor') {
        return { entityId: descriptor.noteId, entityType: 'note' };
      }
    }

    if (state.selectedDocumentId !== null) {
      return {
        entityId: state.selectedDocumentId,
        entityType: 'document',
        documentId: state.selectedDocumentId,
      };
    }
    return null;
  }

  getLinkUnderCursor(): EntityRef | null {
    return this.#store.getSnapshot().linkUnderCursor;
  }

  // --- resolving entities to panels ----------------------------------------

  async describeEntity(entity: EntityRef): Promise<PanelDescriptor | null> {
    switch (entity.entityType) {
      case 'document': {
        const { item } = await call('library:getDocument', { documentId: entity.entityId });
        this.#store.rememberDocumentTitle(item.document.id, item.document.title);
        const docType = item.document.docType === 'pdf' ? 'pdf' : 'webpage';
        return readerDescriptorFor(item.document.id, docType, entity.location ?? null);
      }
      case 'annotation': {
        const { annotation } = await call('annotation:get', { annotationId: entity.entityId });
        const { item } = await call('library:getDocument', {
          documentId: annotation.documentId,
        });
        this.#store.rememberDocumentTitle(item.document.id, item.document.title);
        this.#store.update({ selectedAnnotationId: annotation.id });
        const docType = item.document.docType === 'pdf' ? 'pdf' : 'webpage';
        // An annotation has no panel of its own: it is revealed inside its document.
        return readerDescriptorFor(
          annotation.documentId,
          docType,
          entity.location ?? anchorToLocation(annotation.anchor),
        );
      }
      case 'note': {
        // Entity ids arrive as opaque strings from links and IPC results; the branded
        // schema is what makes one usable as a NoteId. A malformed id opens nothing
        // rather than throwing out of a navigation command.
        const noteId = NoteIdSchema.safeParse(entity.entityId);
        return noteId.success ? { kind: 'note-editor', noteId: noteId.data, location: null } : null;
      }
      default:
        // `excerpt` and anything added later have no panel; navigation is a no-op rather
        // than an error, so a link to one does not break the command.
        return null;
    }
  }

  // --- links ----------------------------------------------------------------

  async getLinks(entity: EntityRef): Promise<readonly Link[]> {
    if (entity.entityType === 'excerpt') return [];
    const { links } = await call('link:findReferences', {
      entityType: entity.entityType,
      entityId: entity.entityId,
      direction: 'both',
    });
    return links;
  }

  async resolveLinks(query: ReferenceQuery): Promise<readonly ResolvedLink[]> {
    if (query.entity.entityType === 'excerpt') return [];

    if (query.linkType !== undefined) {
      // "All links of this type" is a library-wide question, not an entity-scoped one:
      // the point of the command is to see every edge of the same kind.
      const { links } = await call('link:findByType', {
        type: query.linkType,
        direction: query.direction,
      });
      return links;
    }

    const { links } = await call('link:findReferences', {
      entityType: query.entity.entityType,
      entityId: query.entity.entityId,
      direction: query.direction,
    });
    return links;
  }

  showReferences(query: ReferenceQuery, results: readonly ResolvedLink[]): void {
    const state = this.#store.getSnapshot();
    this.#store.update({
      references: {
        query,
        results,
        selectedIndex: results.length === 0 ? null : 0,
        title: referencesTitle(query, results.length),
      },
      // The references panel is a panel, not a modal: it opens and then stays open while
      // the user walks the results (criterion L08).
      sidebars: { ...state.sidebars, bottomPanel: true },
    });
  }

  async stepReference(delta: 1 | -1): Promise<void> {
    const state = this.#store.getSnapshot();
    const references = state.references;
    if (references === null || references.results.length === 0) return;

    const count = references.results.length;
    const current = references.selectedIndex ?? 0;
    const next = (((current + delta) % count) + count) % count;
    const link = references.results[next];
    if (link === undefined) return;

    this.#store.update({ references: { ...references, selectedIndex: next } });
    await this.openReference(link);
  }

  /**
   * Open one reference result. Shared by keyboard stepping and clicking a row, so both
   * behave identically — and neither closes the panel.
   */
  async openReference(link: ResolvedLink): Promise<void> {
    if (link.broken) {
      this.#store.setStatus('That link points at something that no longer exists.', 'error');
      return;
    }
    try {
      const entity = otherEndpointRef(link);
      const descriptor = await this.describeEntity(entity);
      if (descriptor === null) return;
      const plan = resolveOpen(
        { descriptor, mode: 'current', location: entity.location ?? null },
        this.getWorkspace(),
      );
      this.applyPlan(plan);
    } catch (error) {
      const { message } = describeError(error);
      this.#store.setStatus(message, 'error');
    }
  }

  async showPeek(entity: EntityRef): Promise<void> {
    if (entity.entityType === 'excerpt') return;
    try {
      const peek = await call('link:peek', {
        entityType: entity.entityType,
        entityId: entity.entityId,
      });
      this.#store.update({
        peek: {
          title: peek.title,
          excerpt: peek.excerpt,
          locationLabel: peek.locationLabel,
          entity,
          broken: peek.broken,
        },
      });
    } catch (error) {
      this.#store.setStatus(describeError(error).message, 'error');
    }
  }

  // --- workspace chrome -----------------------------------------------------

  revealInLibrary(entity: EntityRef): void {
    const own =
      entity.entityType === 'document' ? DocumentIdSchema.safeParse(entity.entityId) : null;
    const documentId = entity.documentId ?? (own !== null && own.success ? own.data : null);
    if (documentId === null) return;
    const state = this.#store.getSnapshot();
    this.#store.update({
      selectedDocumentId: documentId,
      sidebars: { ...state.sidebars, library: true },
    });
  }

  toggleSidebar(which: 'library' | 'annotations' | 'bottomPanel'): void {
    const state = this.#store.getSnapshot();
    this.#store.update({
      sidebars: { ...state.sidebars, [which]: !state.sidebars[which] },
    });
  }

  async copyToClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.#store.setStatus(`Copied ${text}`);
    } catch {
      // Clipboard permission can be refused; the link is still worth showing so the user
      // can copy it by hand rather than being told nothing happened.
      this.#store.setStatus(`Could not write to the clipboard. Link: ${text}`, 'error');
    }
  }

  currentNavigationLocation(): NavigationLocation | null {
    const state = this.#store.getSnapshot();
    const panelId = state.activePanelId;
    const descriptor = panelId === null ? undefined : state.panels[panelId];
    if (descriptor === undefined) return null;

    const timestamp = Date.now();
    if (descriptor.kind === 'pdf-reader' || descriptor.kind === 'article-reader') {
      const location: DocumentLocation | null = descriptor.location;
      return {
        entityId: descriptor.documentId,
        entityType: 'document',
        documentId: descriptor.documentId,
        ...(location === null ? {} : { location }),
        ...(panelId === null ? {} : { panelId }),
        timestamp,
      };
    }
    if (descriptor.kind === 'note-editor') {
      return {
        entityId: descriptor.noteId,
        entityType: 'note',
        ...(panelId === null ? {} : { panelId }),
        timestamp,
      };
    }
    return null;
  }
}
