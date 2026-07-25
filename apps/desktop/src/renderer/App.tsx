/**
 * The workbench shell (criterion M02).
 *
 * VS Code's arrangement, because the reading task has the same shape: a narrow activity bar
 * that switches what the left sidebar shows, a sidebar, a dockable centre where the actual
 * documents live, a right sidebar for annotations, a bottom panel for reference results, and
 * a status bar. Dockview owns the centre and nothing else.
 *
 * The shell is deliberately thin. It mounts Dockview, hands its API to the store, forwards
 * keystrokes to the workbench, and draws chrome. Every action a button here triggers is a
 * registered command — the same one a keystroke or a panel would run — so the shell holds no
 * behaviour of its own that a test would have to reach through the DOM to exercise.
 */
import { useCallback, useEffect, useRef } from 'react';
import { DockviewReact, type DockviewApi, type DockviewReadyEvent } from 'dockview';
import { COMMAND_IDS } from '@wr/workbench';
import { Panel } from '@wr/shared-ui';
import { AnnotationsView, DOCKVIEW_COMPONENTS, LibraryView, ReferencesView } from './panels.js';
import { useNoteCounts } from './document-data.js';
import { WorkspaceProvider, useWorkspace, useWorkspaceState } from './workspace.js';

export function App(): JSX.Element {
  return (
    <WorkspaceProvider>
      <Shell />
    </WorkspaceProvider>
  );
}

/** Whether a keystroke should be left to the focused editor rather than the workbench. */
function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function Shell(): JSX.Element {
  const { store, workbench, run } = useWorkspace();
  const state = useWorkspaceState();
  useNoteCounts();

  // --- keybindings --------------------------------------------------------
  // One listener for the whole window rather than per-panel handlers: a keybinding is a
  // property of the workbench, and a panel that forgot to attach one would silently not
  // respond to F12 (criterion L09).
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      workbench.contextKeys.set('textInputFocus', isTextInput(event.target));
      void (async () => {
        // Context keys the workbench derives from data — `linkUnderCursor`, `canGoToParent`
        // — have to be current *before* the lookup, or F12 is evaluated against the state
        // the previous keystroke left behind.
        await workbench.refreshDerivedContext();
        const commandId = await workbench.handleKeyDown(event);
        if (commandId !== null) {
          event.preventDefault();
          event.stopPropagation();
        }
      })().catch((failure: unknown) => {
        store.setStatus(
          failure instanceof Error ? failure.message : 'That command failed.',
          'error',
        );
      });
    },
    [store, workbench],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);

  return (
    <div className="wr-shell" data-testid="app-shell">
      <div className="wr-shell__body">
        <ActivityBar />
        {state.sidebars.library && (
          <aside className="wr-sidebar wr-sidebar--left" data-testid="library-sidebar">
            <div className="wr-sidebar__title">Library</div>
            <LibraryView testId="library-list" />
          </aside>
        )}
        <div className="wr-centre">
          <MainArea />
          {state.sidebars.bottomPanel && <BottomPanel />}
        </div>
        {state.sidebars.annotations && (
          <aside className="wr-sidebar wr-sidebar--right" data-testid="annotations-sidebar">
            <div className="wr-sidebar__title">Annotations</div>
            <AnnotationsView testId="annotations-list" />
          </aside>
        )}
      </div>
      <PeekOverlay />
      <StatusBar />
      <button
        type="button"
        className="wr-hidden-action"
        data-testid="command-find-references"
        onClick={() => void run(COMMAND_IDS.findAllReferences)}
      >
        Find All References
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity bar
// ---------------------------------------------------------------------------

interface ActivityButtonProps {
  readonly label: string;
  readonly glyph: string;
  readonly active: boolean;
  readonly testId: string;
  readonly onClick: () => void;
}

function ActivityButton({ label, glyph, active, testId, onClick }: ActivityButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={active ? 'wr-activity__button wr-activity__button--active' : 'wr-activity__button'}
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-testid={testId}
      onClick={onClick}
    >
      {glyph}
    </button>
  );
}

function ActivityBar(): JSX.Element {
  const { run } = useWorkspace();
  const state = useWorkspaceState();

  return (
    <nav className="wr-activity" data-testid="activity-bar">
      <ActivityButton
        label="Library"
        glyph="◫"
        active={state.sidebars.library}
        testId="activity-library"
        onClick={() => void run(COMMAND_IDS.toggleLibrarySidebar)}
      />
      <ActivityButton
        label="Search"
        glyph="⌕"
        active={false}
        testId="activity-search"
        onClick={() => void run(COMMAND_IDS.openSearch)}
      />
      <ActivityButton
        label="Graph"
        glyph="◈"
        active={false}
        testId="activity-graph"
        onClick={() => void run(COMMAND_IDS.openLinkGraph)}
      />
      <ActivityButton
        label="Annotations"
        glyph="✎"
        active={state.sidebars.annotations}
        testId="activity-annotations"
        onClick={() => void run(COMMAND_IDS.toggleAnnotationSidebar)}
      />
    </nav>
  );
}

// ---------------------------------------------------------------------------
// The Dockview centre
// ---------------------------------------------------------------------------

function MainArea(): JSX.Element {
  const { store } = useWorkspace();
  const state = useWorkspaceState();

  // Dockview's API is handed over once, in `onReady`, and everything after that reads it
  // off the store. Holding it in React state instead would re-run this effect on every
  // layout change.
  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      store.api = event.api;
      // Dockview only tells us a panel is gone; the descriptor that says what it was
      // showing is ours to drop, or the next panel to reuse that id inherits it.
      event.api.onDidRemovePanel((panel) => store.removePanel(panel.id));
      event.api.onDidActivePanelChange((panel) => {
        store.update({ activePanelId: panel?.id ?? null });
        const descriptor = panel === undefined ? null : store.panel(panel.id);
        if (descriptor !== null && descriptor.kind === 'pdf-reader') {
          store.update({ selectedDocumentId: descriptor.documentId });
        }
      });
      // A layout that arrived before Dockview was ready is parked in the store.
      applyPendingLayout(event.api, store);
    },
    [store],
  );

  // The other order: Dockview was ready first, and the layout arrives over IPC afterwards.
  const applied = useRef(false);
  useEffect(() => {
    if (applied.current) return;
    const api = store.api;
    if (api === null || state.pendingLayout === null) return;
    applied.current = true;
    applyPendingLayout(api, store);
  }, [state.pendingLayout, store]);

  return (
    <div className="wr-main" data-testid="dockview-container">
      <DockviewReact
        className="dockview-theme-dark"
        components={DOCKVIEW_COMPONENTS}
        onReady={onReady}
        watermarkComponent={Watermark}
      />
    </div>
  );
}

function applyPendingLayout(api: DockviewApi, store: ReturnType<typeof useWorkspace>['store']): void {
  const pending = store.getSnapshot().pendingLayout;
  if (pending === null) {
    store.markLayoutApplied();
    return;
  }
  try {
    // The blob is whatever Dockview serialized last time. It is validated by shape when it
    // is read back out of the database; Dockview is the only thing that can interpret it.
    api.fromJSON(pending.dockview as Parameters<DockviewApi['fromJSON']>[0]);
  } catch (failure) {
    // A layout Dockview refuses is not worth losing the session over: start clean and say
    // what happened, rather than showing an empty workspace with no explanation.
    api.clear();
    store.setStatus(
      `Could not restore the previous layout: ${failure instanceof Error ? failure.message : 'unreadable'}`,
      'error',
    );
  } finally {
    store.markLayoutApplied();
  }
}

/** What the centre shows when nothing is open. */
function Watermark(): JSX.Element {
  return (
    <div className="wr-watermark" data-testid="workspace-watermark">
      <p>Open a document from the library.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bottom panel, peek, status bar
// ---------------------------------------------------------------------------

function BottomPanel(): JSX.Element {
  const { store } = useWorkspace();
  const state = useWorkspaceState();
  const title = state.references?.title ?? 'References';

  return (
    <section className="wr-bottom" data-testid="bottom-panel">
      <Panel
        title={title}
        testId="bottom-panel-body"
        toolbar={
          <button
            type="button"
            className="wr-button wr-button--icon"
            title="Close panel"
            aria-label="Close panel"
            data-testid="close-bottom-panel"
            onClick={() =>
              store.update({ sidebars: { ...state.sidebars, bottomPanel: false } })
            }
          >
            ✕
          </button>
        }
      >
        <ReferencesView testId="references-list" />
      </Panel>
    </section>
  );
}

/** The inline preview `Alt+F12` opens. Dismissed with Escape or the close button. */
function PeekOverlay(): JSX.Element | null {
  const { store, workbench } = useWorkspace();
  const state = useWorkspaceState();
  const peek = state.peek;

  useEffect(() => {
    if (peek === null) return;
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') store.update({ peek: null });
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [peek, store]);

  if (peek === null) return null;

  return (
    <div className="wr-peek" data-testid="peek-overlay">
      <div className="wr-peek__header">
        <span className="wr-peek__title">{peek.title}</span>
        <span className="wr-peek__location">{peek.locationLabel}</span>
        <button
          type="button"
          className="wr-button wr-button--icon"
          aria-label="Close preview"
          data-testid="close-peek"
          onClick={() => store.update({ peek: null })}
        >
          ✕
        </button>
      </div>
      <p className="wr-peek__excerpt">{peek.excerpt}</p>
      <button
        type="button"
        className="wr-button"
        data-testid="peek-open"
        disabled={peek.broken}
        onClick={() => {
          store.update({ peek: null });
          void workbench.navigate(peek.entity, 'current');
        }}
      >
        Open
      </button>
    </div>
  );
}

function StatusBar(): JSX.Element {
  const { workbench } = useWorkspace();
  const state = useWorkspaceState();
  const status = state.status;
  const openCount = Object.keys(state.panels).length;

  return (
    <footer className="wr-status" data-testid="status-bar">
      <StatusAction
        label="Back"
        testId="status-back"
        onClick={() => void workbench.commands.execute(COMMAND_IDS.goBack, {}, workbench.context())}
      />
      <StatusAction
        label="Forward"
        testId="status-forward"
        onClick={() =>
          void workbench.commands.execute(COMMAND_IDS.goForward, {}, workbench.context())
        }
      />
      <span
        className={status?.tone === 'error' ? 'wr-status__message wr-status__message--error' : 'wr-status__message'}
        data-testid="status-message"
        role={status?.tone === 'error' ? 'alert' : undefined}
      >
        {status?.text ?? ''}
      </span>
      <span className="wr-status__spacer" />
      <span className="wr-status__count" data-testid="status-panel-count">
        {openCount === 1 ? '1 panel' : `${String(openCount)} panels`}
      </span>
    </footer>
  );
}

function StatusAction({
  label,
  testId,
  onClick,
}: {
  readonly label: string;
  readonly testId: string;
  readonly onClick: () => void;
}): JSX.Element {
  return (
    <button type="button" className="wr-status__button" data-testid={testId} onClick={onClick}>
      {label}
    </button>
  );
}
