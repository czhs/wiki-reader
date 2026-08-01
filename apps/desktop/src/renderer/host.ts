/**
 * `WorkbenchHost` over Dockview and the IPC bridge.
 *
 * `@wr/workbench` decides *what* should happen — which panel a navigation lands in, which
 * links a reference query covers, what the history contains — and hands down a plan. This
 * module is the only place that plan meets a real workspace. Keeping the split means the
 * interesting rules stay testable in plain Node, and this file stays mechanical.
 */
import { anchorToLocation, ellipsize } from '@wr/document-model';
import {
  AnnotationIdSchema,
  DocumentIdSchema,
  NoteIdSchema,
  QuestionIdSchema,
  parseJournalEntityId,
  type DocumentLocation,
  type DocumentType,
  type Link,
  type NavigationLocation,
  type ResolvedLink,
} from '@wr/shared-types';
import {
  isReaderPanel,
  linkTypeLabel,
  normaliseSidebars,
  readerDescriptorFor,
  resolveOpen,
  toggleSidebarState,
  type BlockActionRequest,
  type EntityLinkRequest,
  type EntityRef,
  type OpenPlan,
  type PanelDescriptor,
  type PanelKind,
  type ReferenceQuery,
  type WorkbenchHost,
  type WorkspaceSnapshot,
} from '@wr/workbench';
import { blockSurface } from './block-surfaces.js';
import { EMPTY_CODE_BLOCK } from './block-source.js';
import { call, describeError } from './ipc.js';
import type { WorkspaceStore } from './store.js';

/**
 * Which reader a document type opens in.
 *
 * Anything that is not a PDF or markdown falls to the article reader, which is the saved-page
 * view: an unknown type is more likely to be an archived page than a wiki file.
 */
function readerTypeFor(docType: DocumentType): 'pdf' | 'webpage' | 'markdown' {
  if (docType === 'pdf') return 'pdf';
  if (docType === 'markdown') return 'markdown';
  return 'webpage';
}

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
    case 'markdown-reader':
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
    case 'link-graph':
      return 'Graph';
    case 'wiki':
      return 'Wiki';
    case 'focus':
      // The file it is focused on, once that file's title is known — the tab is how you can
      // tell, without looking at it, where a crawl has got to.
      return descriptor.documentId === null
        ? 'Focus'
        : `Focus · ${documentTitles[descriptor.documentId] ?? 'file'}`;
    case 'ledger':
      // The file whose account this is, once its title is known — the same reasoning as the
      // focused view's tab, and for the same one-tab-per-kind reason.
      return descriptor.documentId === null
        ? 'Links'
        : `Links · ${documentTitles[descriptor.documentId] ?? 'file'}`;
    case 'notebook':
      // The panel sets its tab to the notebook's own title once it has read the page. This
      // is what a tab that has not loaded yet has to say for itself.
      return 'Notebook';
    case 'notebook-directory':
      return 'Notebooks';
    case 'help':
      return 'Help';
    case 'guide':
      return 'Guide';
    case 'journal':
      // Retitled to the notebook and the day being read as soon as the page knows them.
      return 'Journal';
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

/** As much of a highlight as fits in a note's title without becoming the note. */
const EXCERPT_IN_TITLE = 41;

function excerptTitle(text: string): string {
  return ellipsize(text, EXCERPT_IN_TITLE);
}

/**
 * An endpoint id checked against the schema for what it claims to be.
 *
 * A link endpoint is `(type, id)` and the two have to agree: `link:create` takes both as free
 * strings, so a document id sent as an annotation would be written happily and resolve to
 * nothing forever after. Types with no minted id of their own — a journal day is
 * `<notebook>:<date>` — are accepted as any non-empty string, which is what they are.
 */
function parseEntityId(entity: EntityRef): string | null {
  const parsed =
    entity.entityType === 'document'
      ? DocumentIdSchema.safeParse(entity.entityId)
      : entity.entityType === 'annotation'
        ? AnnotationIdSchema.safeParse(entity.entityId)
        : entity.entityType === 'note'
          ? NoteIdSchema.safeParse(entity.entityId)
          : null;
  if (parsed === null) return entity.entityId === '' ? null : entity.entityId;
  return parsed.success ? parsed.data : null;
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
      // A re-seated panel is one tab serving every subject, so revealing it has to change what
      // it is showing. Everything else keeps the descriptor it has earned — see
      // `RESEATED_PANEL_KINDS`.
      if (plan.descriptor !== null) {
        this.#store.setPanel(plan.panelId, plan.descriptor);
        panel.api.setTitle(titleFor(plan.descriptor, this.#store.getSnapshot().documentTitles));
      }
      if (plan.focus) {
        panel.api.setActive();
        this.#callbacks.onFocusPanel?.(plan.panelId);
      }
      if (plan.location !== null) this.#store.requestReveal(plan.panelId, plan.location);
      this.#syncSelectionFrom(plan.panelId, { keepAnnotation: true });
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
    this.#syncSelectionFrom(plan.panelId, { keepAnnotation: true });
  }

  /**
   * Close one tab, leaving the window alone.
   *
   * Dockview disposes a group once its last panel goes, so closing the only tab of a split
   * group is also how that group is closed. Closing the last tab in the workspace leaves an
   * empty centre showing the watermark: the library sidebar is still there and the reader is
   * still running, so there is nothing about zero open documents that warrants taking the
   * window down.
   */
  closePanel(panelId: string | null): void {
    const api = this.#store.api;
    if (api === null) return;
    const target = panelId ?? api.activePanel?.id ?? null;
    if (target === null) return;
    const panel = api.getPanel(target);
    if (panel === undefined) return;
    api.removePanel(panel);
  }

  /** Close every tab in one group, which is how a split is undone in one action. */
  closeGroup(groupId: string | null): void {
    const api = this.#store.api;
    if (api === null) return;
    const group =
      groupId === null
        ? (api.activeGroup ?? null)
        : (api.groups.find((candidate) => candidate.id === groupId) ?? null);
    if (group === null) return;
    // A copy, because removing a panel mutates the group's own list as we walk it.
    for (const panel of [...group.panels]) api.removePanel(panel);
  }

  /**
   * The tab the researcher just switched to is now the file they are on.
   *
   * Called from the shell for *every* reader, which is the half that was missing: only a
   * `pdf-reader` re-pointed `selectedDocumentId`, so clicking back to a saved page or a markdown
   * file left the whole app — the annotations sidebar, the ledger chord, the focused view, the
   * link picker's map — aimed at whatever PDF had been open before.
   *
   * A highlight belongs to the file it was made in, so switching to another file's tab ends the
   * highlight's turn as the current selection rather than pairing it with a document it is not
   * in. Programmatic navigation says otherwise: it may have chosen the highlight *and* the
   * file, so `applyPlan` keeps what it set.
   */
  activatePanel(panelId: string): void {
    this.#syncSelectionFrom(panelId, { keepAnnotation: false });
  }

  /** Keep the library highlight and annotation sidebar pointed at whatever just opened. */
  #syncSelectionFrom(panelId: string, options: { keepAnnotation: boolean }): void {
    const descriptor = this.#store.panel(panelId);
    if (descriptor === null) return;
    if (!isReaderPanel(descriptor)) {
      this.#store.update({ activePanelId: panelId });
      return;
    }
    const state = this.#store.getSnapshot();
    const movedFile = state.selectedDocumentId !== descriptor.documentId;
    this.#store.update({
      selectedDocumentId: descriptor.documentId,
      activePanelId: panelId,
      ...(movedFile && !options.keepAnnotation ? { selectedAnnotationId: null } : {}),
    });
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
      if (isReaderPanel(descriptor)) {
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
        return readerDescriptorFor(
          item.document.id,
          readerTypeFor(item.document.docType),
          entity.location ?? null,
        );
      }
      case 'annotation': {
        const { annotation } = await call('annotation:get', { annotationId: entity.entityId });
        const { item } = await call('library:getDocument', {
          documentId: annotation.documentId,
        });
        this.#store.rememberDocumentTitle(item.document.id, item.document.title);
        // Both halves, together: `getActiveEntity` pairs them, and a highlight paired with a
        // file it is not in sends the ledger and the focused view to the wrong paper.
        this.#store.update({
          selectedAnnotationId: annotation.id,
          selectedDocumentId: DocumentIdSchema.parse(annotation.documentId),
        });
        // An annotation has no panel of its own: it is revealed inside its document.
        return readerDescriptorFor(
          annotation.documentId,
          readerTypeFor(item.document.docType),
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
      case 'question':
        // A notebook has a page of its own, so a reference to one opens it rather than
        // landing nowhere. It was `null` while the queue was the only way in.
        return { kind: 'notebook', questionId: entity.entityId };
      case 'journal': {
        // A day opens its notebook's journal (`P02`). The page opens on today and the
        // calendar is how a reader gets to another day, which is why the date does not
        // travel on the descriptor — see `JournalPanelSchema`.
        const parsed = parseJournalEntityId(entity.entityId);
        return parsed === null ? null : { kind: 'journal', questionId: parsed.notebookId };
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
    // Revealing *shows* the library rather than toggling it, so it goes through
    // `normaliseSidebars` instead of `toggleSidebarState`: setting `library: true` on top of
    // an open queue would put two sidebars in the one slot, which is the defect U04 fixes.
    this.#store.update({
      selectedDocumentId: documentId,
      sidebars: normaliseSidebars({
        ...state.sidebars,
        library: true,
        questions: false,
        librarian: false,
      }),
    });
  }

  toggleSidebar(
    which: 'library' | 'questions' | 'librarian' | 'annotations' | 'bottomPanel',
  ): void {
    const state = this.#store.getSnapshot();
    // The one-slot rule lives in `toggleSidebarState`, not here, because restore applies it
    // too — two copies would let a reopened workspace disagree with a clicked one.
    this.#store.update({ sidebars: toggleSidebarState(state.sidebars, which) });
  }

  showCommands(open: boolean): void {
    this.#store.update({ commandsOpen: open });
  }

  showFiles(open: boolean): void {
    // One overlay at a time: the file list is often opened *from* the command list, and
    // leaving that stacked underneath would hide the thing it just opened.
    this.#store.update({ filesOpen: open, ...(open ? { commandsOpen: false } : {}) });
  }

  /**
   * The notebook the keyboard means when it says "the notebook".
   *
   * The one being looked at is the honest answer — the notebook page or the journal that is
   * focused, else any that is open. Failing that, the first in the hand-arranged order, which
   * is what the queue already calls the work in front. With no notebooks at all there is
   * nothing to open and the caller is told so rather than being handed an invented one.
   */
  async notebookInHand(): Promise<string | null> {
    const state = this.#store.getSnapshot();
    const active = state.activePanelId === null ? null : state.panels[state.activePanelId];
    if (active !== undefined && active !== null) {
      if (active.kind === 'notebook' || active.kind === 'journal') return active.questionId;
    }
    for (const panel of Object.values(state.panels)) {
      if (panel.kind === 'notebook' || panel.kind === 'journal') return panel.questionId;
    }
    try {
      const { questions } = await call('question:list', { status: ['active', 'queued'] });
      return questions[0]?.id ?? null;
    } catch (failure) {
      this.#store.setStatus(describeError(failure).message, 'error');
      return null;
    }
  }

  promptEntityLink(source: EntityRef): void {
    // Closing the command list is part of opening the picker: the list is how the researcher
    // got here, and leaving it stacked over the picker would hide the thing it just opened.
    this.#store.update({ linkDraftSource: source, commandsOpen: false });
  }

  async createEntityLink(request: EntityLinkRequest): Promise<Link | null> {
    const sourceId = parseEntityId(request.source);
    const targetId = parseEntityId(request.target);
    if (sourceId === null || targetId === null) {
      this.#store.setStatus('That could not be linked.', 'error');
      return null;
    }

    try {
      const { link } = await call('link:create', {
        type: request.type,
        sourceType: request.source.entityType,
        sourceId,
        targetType: request.target.entityType,
        targetId,
        // The researcher chose both ends and the relationship, so the edge is theirs. A
        // `derived` origin here would make it indistinguishable from one the importer wrote,
        // and re-deriving would be entitled to delete it.
        origin: 'manual',
      });
      this.#store.update({ linkDraftSource: null });
      this.#store.setStatus(
        `Linked to ${this.#nameFor(request.target)} — ${linkTypeLabel(request.type)}`,
      );
      return link;
    } catch (failure) {
      this.#store.setStatus(describeError(failure).message, 'error');
      return null;
    }
  }

  promptSendToNotebook(source: EntityRef): void {
    // The command list closes for the same reason it does when the link picker opens: it is
    // how the researcher got here, and leaving it stacked over the picker hides it.
    this.#store.update({ notebookDraftSource: source, commandsOpen: false });
  }

  /**
   * Put what is being read on a notebook's desk (`E01`).
   *
   * `question:attach` and nothing else: a card *is* the `question-references-…` edge, so there
   * is no second mechanism to add and the desk, the graph, the ledger and the references panel
   * all see it the moment it is written. The same channel the excerpt insert uses (`S03`),
   * because quoting a sentence into a page and sending it to the desk are the same claim made
   * in two places.
   */
  async sendToNotebook(
    source: EntityRef,
    /** Named as well as identified: the picker has the title, and the message needs it. */
    notebook: { readonly id: string; readonly title: string },
  ): Promise<boolean> {
    const notebookId = QuestionIdSchema.safeParse(notebook.id);
    const targetId = parseEntityId(source);
    if (!notebookId.success || targetId === null) {
      this.#store.setStatus('That could not be sent to a notebook.', 'error');
      return false;
    }
    if (source.entityType !== 'document' && source.entityType !== 'annotation') {
      // The channel takes a paper or a highlight, which is what reading produces. Anything
      // else reaching here is a caller inventing a gesture rather than a researcher using one.
      this.#store.setStatus('Only a file or a highlight can be sent to a notebook.', 'error');
      return false;
    }

    try {
      await call('question:attach', {
        questionId: notebookId.data,
        targetType: source.entityType,
        targetId,
      });
      this.#store.update({ notebookDraftSource: null });
      this.#store.setStatus(`Sent ${this.#nameFor(source)} to “${notebook.title}”.`);
      return true;
    } catch (failure) {
      this.#store.setStatus(describeError(failure).message, 'error');
      return false;
    }
  }

  /** How an endpoint reads in a sentence: a paper by its title, a highlight by its words. */
  #nameFor(entity: EntityRef): string {
    const state = this.#store.getSnapshot();
    if (entity.entityType === 'annotation') {
      for (const list of Object.values(state.annotations)) {
        const found = list.find((entry) => entry.id === entity.entityId);
        if (found !== undefined) return `“${excerptTitle(found.selectedText)}”`;
      }
      return 'that highlight';
    }
    return `“${state.documentTitles[entity.entityId] ?? 'that document'}”`;
  }

  async createNoteFrom(entity: EntityRef): Promise<string | null> {
    try {
      if (entity.entityType === 'annotation') {
        const annotationId = AnnotationIdSchema.safeParse(entity.entityId);
        if (!annotationId.success) return null;
        // Read the highlight back rather than titling the note from whatever the sidebar last
        // rendered: the passage is what the note is about, and it has to be the real one.
        const { annotation } = await call('annotation:get', { annotationId: annotationId.data });
        const { note } = await call('note:create', {
          title: `Note on “${excerptTitle(annotation.selectedText)}”`,
          contentJson: null,
          contentText: '',
          attachToAnnotationId: annotationId.data,
        });
        return note.id;
      }

      const documentId = DocumentIdSchema.safeParse(entity.documentId ?? entity.entityId);
      if (!documentId.success) return null;
      const titles = this.#store.getSnapshot().documentTitles;
      const { note } = await call('note:create', {
        title: `Note on ${titles[documentId.data] ?? 'this document'}`,
        contentJson: null,
        contentText: '',
        attachToDocumentId: documentId.data,
      });
      return note.id;
    } catch (failure) {
      this.#store.setStatus(describeError(failure).message, 'error');
      return null;
    }
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

  /**
   * Do something to one block of a writing surface (`R01`).
   *
   * The surface is looked up by the name its owner registered rather than reached through the
   * tree: this method is called from a command handler, which is not a render, so there is no
   * component in scope to ask. With no surface mounted the researcher is told what would make
   * it work — the same shape every other command with a missing subject takes.
   */
  runBlockAction(request: BlockActionRequest): void {
    const surface = blockSurface(request.surfaceId);
    if (surface === null) {
      this.#store.setStatus(
        'Open a notebook page or a journal day first — a block belongs to one of them.',
        'error',
      );
      return;
    }
    if (request.action === 'edit') {
      if (request.index === null) {
        this.#store.setStatus('Right-click the block you want to edit.', 'error');
        return;
      }
      surface.open(request.index);
      return;
    }
    surface.insertAfter(request.index, request.action === 'add-code' ? EMPTY_CODE_BLOCK : '');
  }

  currentNavigationLocation(): NavigationLocation | null {
    const state = this.#store.getSnapshot();
    const panelId = state.activePanelId;
    const descriptor = panelId === null ? undefined : state.panels[panelId];
    if (descriptor === undefined) return null;

    const timestamp = Date.now();
    if (isReaderPanel(descriptor)) {
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
