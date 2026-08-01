/**
 * The workspace state the shell and the workbench share.
 *
 * This is a plain external store rather than React state because the `WorkbenchHost`
 * interface is synchronous and is called from command handlers, not from render. A
 * `useState` value captured in a closure would be whatever it was when the command was
 * registered; a store read is always current. React subscribes through
 * `useSyncExternalStore`, so components still re-render normally.
 *
 * Dockview owns the geometry. This owns everything Dockview cannot know: what each panel is
 * showing, which entity is selected, and what the references panel is listing.
 */
import type { DockviewApi } from 'dockview';
import type {
  AnnotationId,
  AnnotationWithAnchor,
  DocumentId,
  DocumentLocation,
  ResolvedLink,
  ResolvedLocation,
} from '@wr/shared-types';
import type {
  EntityRef,
  PanelDescriptor,
  ReferenceQuery,
  SerializedWorkspace,
  SidebarState,
} from '@wr/workbench';

/** A location a reader panel should scroll to. The counter re-triggers an identical reveal. */
export interface RevealRequest {
  readonly location: DocumentLocation;
  readonly seq: number;
}

export interface ReferencesState {
  readonly query: ReferenceQuery;
  readonly results: readonly ResolvedLink[];
  readonly selectedIndex: number | null;
  readonly title: string;
}

export interface PeekState {
  readonly title: string;
  readonly excerpt: string;
  readonly locationLabel: string;
  readonly entity: EntityRef;
  readonly broken: boolean;
}

export interface StatusMessage {
  readonly text: string;
  readonly tone: 'info' | 'error';
}

export interface WorkspaceState {
  /** Panel id -> what that panel is showing. Mirrors Dockview's panel set. */
  readonly panels: Readonly<Record<string, PanelDescriptor>>;
  readonly reveals: Readonly<Record<string, RevealRequest>>;
  readonly sidebars: SidebarState;
  readonly activePanelId: string | null;
  readonly selectedDocumentId: DocumentId | null;
  readonly selectedAnnotationId: AnnotationId | null;
  readonly references: ReferencesState | null;
  readonly peek: PeekState | null;
  /** The internal link the pointer or keyboard focus is currently over. */
  readonly linkUnderCursor: EntityRef | null;
  readonly status: StatusMessage | null;
  /** Document titles seen so far, so a tab can be labelled without another round trip. */
  readonly documentTitles: Readonly<Record<string, string>>;
  /**
   * Wiki page name -> the corpus document that answers it.
   *
   * Held here rather than fetched per reader because every open markdown panel needs the same
   * index to decide whether a `[[link]]` is a link or a page still to be written.
   */
  readonly wikilinkTargets: Readonly<Record<string, { documentId: string; title: string }>>;
  /**
   * Annotations per document, owned by the reader panel showing that document.
   *
   * The annotation sidebar and the reader must agree on the list — a highlight created in
   * the reader has to appear in the sidebar immediately — and two independent fetches would
   * drift. The reader is the writer because it is the only component that knows when its
   * document actually loaded.
   */
  readonly annotations: Readonly<Record<string, readonly AnnotationWithAnchor[]>>;
  /**
   * Where each anchor resolved, per document, as reported by the reader that painted it.
   * The sidebar shows anchor health from this; only the reader has the page text to know.
   */
  readonly resolutions: Readonly<Record<string, ReadonlyMap<string, ResolvedLocation | null>>>;
  /** Notes attached per annotation id, so the sidebar can show which highlights have one. */
  readonly noteCounts: ReadonlyMap<string, number>;
  /**
   * A restored Dockview blob that has not been applied yet.
   *
   * The layout arrives over IPC and Dockview becomes ready independently, in either order,
   * so the blob is parked here until both have happened. Wrapped in an object because the
   * blob itself is legitimately `null` for a workspace that was never split.
   */
  readonly pendingLayout: { readonly dockview: unknown } | null;
  /** False until the persisted layout has been applied, so nothing is saved over it. */
  readonly layoutRestored: boolean;
  /**
   * Whether the command list is showing (`K03`).
   *
   * Deliberately not part of `sidebars`: it is not a sidebar, it is not restored with the
   * layout, and a workspace that reopened with a modal over it would be a bug.
   */
  readonly commandsOpen: boolean;
  /**
   * What a link is being made *from*, while the picker is up. Null when it is not.
   *
   * An entity reference rather than a document id, because a highlight is one of the things
   * that can be linked from (`H02`) — the picker has to know whether the sentence or the paper
   * it lives in is the end being asserted about.
   */
  readonly linkDraftSource: EntityRef | null;
}

export function initialWorkspaceState(): WorkspaceState {
  return {
    panels: {},
    reveals: {},
    sidebars: {
      library: true,
      questions: false,
      librarian: false,
      annotations: false,
      bottomPanel: false,
    },
    activePanelId: null,
    selectedDocumentId: null,
    selectedAnnotationId: null,
    references: null,
    peek: null,
    linkUnderCursor: null,
    status: null,
    documentTitles: {},
    wikilinkTargets: {},
    annotations: {},
    resolutions: {},
    noteCounts: new Map(),
    pendingLayout: null,
    layoutRestored: false,
    commandsOpen: false,
    linkDraftSource: null,
  };
}

export class WorkspaceStore {
  #state: WorkspaceState = initialWorkspaceState();
  #listeners = new Set<() => void>();
  #revealSeq = 0;

  /** Set once Dockview is ready. Null before that, and every caller checks. */
  api: DockviewApi | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = (): WorkspaceState => this.#state;

  #commit(next: WorkspaceState): void {
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }

  update(patch: Partial<WorkspaceState>): void {
    this.#commit({ ...this.#state, ...patch });
  }

  setPanel(panelId: string, descriptor: PanelDescriptor): void {
    this.#commit({
      ...this.#state,
      panels: { ...this.#state.panels, [panelId]: descriptor },
    });
  }

  removePanel(panelId: string): void {
    const panels = { ...this.#state.panels };
    const reveals = { ...this.#state.reveals };
    delete panels[panelId];
    delete reveals[panelId];
    this.#commit({ ...this.#state, panels, reveals });
  }

  panel(panelId: string): PanelDescriptor | null {
    return this.#state.panels[panelId] ?? null;
  }

  /** Ask a reader panel to scroll somewhere. Always a new `seq`, so repeats still fire. */
  requestReveal(panelId: string, location: DocumentLocation): void {
    this.#revealSeq += 1;
    this.#commit({
      ...this.#state,
      reveals: { ...this.#state.reveals, [panelId]: { location, seq: this.#revealSeq } },
    });
  }

  /** Replace the wiki page index. Rebuilt whenever the library list is refreshed. */
  setWikilinkTargets(targets: Readonly<Record<string, { documentId: string; title: string }>>): void {
    this.#commit({ ...this.#state, wikilinkTargets: targets });
  }

  rememberDocumentTitle(documentId: string, title: string): void {
    if (this.#state.documentTitles[documentId] === title) return;
    this.#commit({
      ...this.#state,
      documentTitles: { ...this.#state.documentTitles, [documentId]: title },
    });
  }

  setStatus(text: string, tone: StatusMessage['tone'] = 'info'): void {
    this.update({ status: { text, tone } });
  }

  setAnnotations(documentId: string, annotations: readonly AnnotationWithAnchor[]): void {
    this.#commit({
      ...this.#state,
      annotations: { ...this.#state.annotations, [documentId]: annotations },
    });
  }

  setResolutions(
    documentId: string,
    resolutions: ReadonlyMap<string, ResolvedLocation | null>,
  ): void {
    // The reader republishes resolutions every time it repaints, and most repaints resolve
    // every anchor to exactly where it already was. Committing those would wake every
    // subscriber for no change — and because the reader's own memo depends on state the
    // commit replaces, it is also how a repaint turns into an unbounded render loop.
    if (sameResolutions(this.#state.resolutions[documentId], resolutions)) return;
    this.#commit({
      ...this.#state,
      resolutions: { ...this.#state.resolutions, [documentId]: resolutions },
    });
  }

  setNoteCounts(noteCounts: ReadonlyMap<string, number>): void {
    this.#commit({ ...this.#state, noteCounts });
  }

  /** Replace the whole panel map, used when a persisted layout is restored. */
  replacePanels(panels: Readonly<Record<string, PanelDescriptor>>): void {
    this.#commit({ ...this.#state, panels: { ...panels } });
  }

  /**
   * Adopt a restored workspace.
   *
   * The descriptors go in before the Dockview blob is parked, because Dockview builds each
   * panel component the moment it deserializes its own layout and a component with no
   * descriptor has nothing to render. A workspace with no Dockview blob is finished here:
   * there is nothing for the shell to apply, so it counts as restored immediately.
   */
  applyRestoredWorkspace(workspace: SerializedWorkspace): void {
    const hasLayout = workspace.dockview !== null && workspace.dockview !== undefined;
    this.#commit({
      ...this.#state,
      panels: { ...workspace.panels },
      activePanelId: workspace.activePanelId,
      sidebars: workspace.sidebars,
      pendingLayout: hasLayout ? { dockview: workspace.dockview } : null,
      layoutRestored: !hasLayout,
    });
  }

  /** Called by the shell once the parked Dockview blob has been handed to Dockview. */
  markLayoutApplied(): void {
    this.#commit({ ...this.#state, pendingLayout: null, layoutRestored: true });
  }
}

/**
 * Whether two anchor-resolution maps say the same thing.
 *
 * Compared by value because the reader builds a fresh map, and fresh `ResolvedLocation`
 * objects, on every repaint; identity would report "changed" every single time and defeat
 * the guard entirely.
 */
function sameResolutions(
  previous: ReadonlyMap<string, ResolvedLocation | null> | undefined,
  next: ReadonlyMap<string, ResolvedLocation | null>,
): boolean {
  if (previous === undefined) return false;
  if (previous === next) return true;
  if (previous.size !== next.size) return false;
  for (const [id, location] of next) {
    if (!previous.has(id)) return false;
    const before = previous.get(id) ?? null;
    if (before === location) continue;
    if (before === null || location === null) return false;
    if (JSON.stringify(before) !== JSON.stringify(location)) return false;
  }
  return true;
}
