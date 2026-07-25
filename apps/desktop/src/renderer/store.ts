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
import type { AnnotationId, DocumentId, DocumentLocation } from '@wr/shared-types';
import type {
  EntityRef,
  PanelDescriptor,
  ReferenceQuery,
  SerializedWorkspace,
  SidebarState,
} from '@wr/workbench';
import type { ResolvedLink } from '@wr/shared-types';

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
   * A restored Dockview blob that has not been applied yet.
   *
   * The layout arrives over IPC and Dockview becomes ready independently, in either order,
   * so the blob is parked here until both have happened. Wrapped in an object because the
   * blob itself is legitimately `null` for a workspace that was never split.
   */
  readonly pendingLayout: { readonly dockview: unknown } | null;
  /** False until the persisted layout has been applied, so nothing is saved over it. */
  readonly layoutRestored: boolean;
}

export function initialWorkspaceState(): WorkspaceState {
  return {
    panels: {},
    reveals: {},
    sidebars: { library: true, annotations: false, bottomPanel: false },
    activePanelId: null,
    selectedDocumentId: null,
    selectedAnnotationId: null,
    references: null,
    peek: null,
    linkUnderCursor: null,
    status: null,
    documentTitles: {},
    pendingLayout: null,
    layoutRestored: false,
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
