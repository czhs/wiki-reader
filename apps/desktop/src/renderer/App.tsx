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
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import {
  DockviewDefaultTab,
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
} from 'dockview';
import {
  CHROME_BOUNDS,
  COMMAND_IDS,
  chromeExtent,
  isReaderPanel,
  openLeftSidebar,
  resizeChrome,
  toggleChromeMinimized,
  type ChromePanel,
  type LeftSidebar as LeftSidebarName,
  type PanelDescriptor,
  type Platform,
} from '@wr/workbench';
import { Panel } from '@wr/shared-ui';
import {
  AnnotationsView,
  DOCKVIEW_COMPONENTS,
  ImportFromZotero,
  LibraryView,
  ReferencesView,
} from './panels.js';
import { useNoteCounts } from './document-data.js';
import {
  CommandList,
  FilePalette,
  LinkPicker,
  NotebookPicker,
  Chord,
} from './overlays.js';
import { ContextMenu, entityMenuArgs, useOpenContextMenu } from './context-menu.js';
import { JournalPopup } from './journal-panel.js';
import { QueueView } from './queue-panel.js';
import { LibrarianPopup } from './librarian-panel.js';
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
        <LeftSidebar />
        <div className="wr-centre">
          <MainArea />
          {state.sidebars.bottomPanel && <BottomPanel />}
        </div>
        {state.sidebars.annotations && <AnnotationsSidebar />}
      </div>
      <PeekOverlay />
      <ContextMenu />
      <CommandList />
      <FilePalette />
      <LinkPicker />
      <NotebookPicker />
      <JournalPopup />
      <LibrarianPopup />
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
// The chrome the hand can move (`U09`)
// ---------------------------------------------------------------------------

/**
 * Which way each panel grows, and what its edge is called.
 *
 * The sign is the whole reason this is a table: the left sidebar gets wider as the pointer
 * moves right and the two on the far side get wider as it moves *left*, and writing that as a
 * conditional inside the drag handler is how one of the three ends up inverted and nobody
 * notices until they try it.
 */
const CHROME_EDGES: Readonly<
  Record<ChromePanel, { axis: 'x' | 'y'; sign: 1 | -1; label: string }>
> = {
  left: { axis: 'x', sign: 1, label: 'Drag to resize the sidebar' },
  annotations: { axis: 'x', sign: -1, label: 'Drag to resize the annotations panel' },
  bottom: { axis: 'y', sign: -1, label: 'Drag to resize the panel below' },
};

/** How far one arrow-key press moves an edge. Coarse enough to be worth pressing. */
const CHROME_KEY_STEP = 24;

/**
 * The draggable edge between a panel and the work.
 *
 * A pointer drag rather than a CSS `resize` handle: the size is a persisted number, so the
 * gesture has to end in a value the workspace writes down. The keyboard moves the same edge
 * for the same reason the queue's grip takes arrow keys — an edge that can only be dragged is
 * an edge some people do not have.
 *
 * `role="separator"` with the value it is at, because that is what this is: a window splitter,
 * and a screen reader is entitled to hear the number the pointer is setting.
 */
function ChromeResizer({
  panel,
  testId,
}: {
  readonly panel: ChromePanel;
  readonly testId: string;
}): JSX.Element {
  const { store } = useWorkspace();
  const state = useWorkspaceState();
  const edge = CHROME_EDGES[panel];
  const bounds = CHROME_BOUNDS[panel];
  const size = chromeExtent(state.chrome, panel);

  const apply = useCallback(
    (next: number) => {
      store.update({ chrome: resizeChrome(store.getSnapshot().chrome, panel, next) });
    },
    [panel, store],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const origin = edge.axis === 'x' ? event.clientX : event.clientY;
      // The size the drag started from, read once. Accumulating deltas per move event drifts
      // by a pixel each time the clamp bites, so the panel never comes back to where it was.
      const from = store.getSnapshot().chrome.sizes[panel];

      const onMove = (move: PointerEvent): void => {
        const travelled = (edge.axis === 'x' ? move.clientX : move.clientY) - origin;
        apply(from + edge.sign * travelled);
      };
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (handle.hasPointerCapture(event.pointerId)) {
          handle.releasePointerCapture(event.pointerId);
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [apply, edge.axis, edge.sign, panel, store],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const towards = edge.axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
      if (!towards.includes(event.key)) return;
      event.preventDefault();
      const forwards = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
      apply(store.getSnapshot().chrome.sizes[panel] + edge.sign * forwards * CHROME_KEY_STEP);
    },
    [apply, edge.axis, edge.sign, panel, store],
  );

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={edge.axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={edge.label}
      aria-valuenow={size}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      title={edge.label}
      className={`wr-resizer wr-resizer--${edge.axis === 'x' ? 'vertical' : 'horizontal'}`}
      data-control="shell.resize"
      data-testid={testId}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}

/**
 * Fold a panel to its rail, or unfold it.
 *
 * Not the same act as closing it, and the two sit next to each other on the annotations panel
 * so the difference is visible: folding keeps the panel — it is still what you are working
 * beside, it just stops taking width — and closing takes it away and unlights the activity
 * button. A workspace where the only way to get the reading back was to close the thing you
 * were reading beside is what this is for.
 */
function MinimizeControl({
  panel,
  testId,
  what,
}: {
  readonly panel: ChromePanel;
  readonly testId: string;
  readonly what: string;
}): JSX.Element {
  const { store } = useWorkspace();
  const state = useWorkspaceState();
  const minimized = state.chrome.minimized[panel];
  const label = minimized ? `Unfold ${what}` : `Fold ${what} out of the way`;
  return (
    <button
      type="button"
      className="wr-button wr-button--icon"
      title={label}
      aria-label={label}
      aria-pressed={minimized}
      data-control="shell.minimize"
      data-testid={testId}
      onClick={() => {
        store.update({ chrome: toggleChromeMinimized(store.getSnapshot().chrome, panel) });
      }}
    >
      {minimized ? '▣' : '▬'}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Left sidebar
// ---------------------------------------------------------------------------

/**
 * The single left slot (criterion U04).
 *
 * One element, showing whichever of the four the activity bar last selected. This shipped as
 * four independent `<aside>` siblings, each with its own boolean, so opening all four left the
 * document 252px of a 1440px window — the reader crushed by its own chrome. `toggleSidebarState`
 * enforces that only one is ever set; rendering one slot means the markup cannot stack them
 * even if that rule were ever broken, which is why the fix is in both places rather than only
 * in the state.
 */
function LeftSidebar(): JSX.Element | null {
  const state = useWorkspaceState();
  const open = openLeftSidebar(state.sidebars);
  if (open === null) return null;
  const minimized = state.chrome.minimized.left;

  // The test id stays per-sidebar — `library-sidebar`, `questions-sidebar` — because every
  // existing assertion names the sidebar it means, and a shared id would make "the library is
  // showing" indistinguishable from "some sidebar is showing".
  return (
    <>
      <aside
        className={
          minimized ? 'wr-sidebar wr-sidebar--left wr-sidebar--folded' : 'wr-sidebar wr-sidebar--left'
        }
        data-testid={`${open}-sidebar`}
        data-minimized={minimized ? 'true' : 'false'}
        style={{ width: `${String(chromeExtent(state.chrome, 'left'))}px` }}
      >
        <div className="wr-sidebar__title">
          <span className="wr-sidebar__name">{LEFT_SIDEBAR_TITLES[open]}</span>
          {/* Re-syncing is a library-level action, so it belongs on the library's own header
              rather than inside the list it refreshes. */}
          {!minimized && open === 'library' && <ImportFromZotero compact />}
          <MinimizeControl panel="left" testId="minimize-left-sidebar" what="this sidebar" />
        </div>
        {!minimized && open === 'library' && <LibraryView testId="library-list" />}
        {!minimized && open === 'questions' && <QueueView testId="queue-view" />}
      </aside>
      {/* No edge to drag on a folded panel: there is nothing between the rail and the work
          that a width would mean, and a handle that resizes something invisible is a trap. */}
      {!minimized && <ChromeResizer panel="left" testId="resize-left-sidebar" />}
    </>
  );
}

/**
 * The annotations column, which closes (`U09`).
 *
 * It had no close control at all. The activity bar could toggle it, which is a different
 * gesture in a different place — the researcher's report was of a panel that appeared beside
 * their reading and could not be got rid of from the panel itself. So it has both things now,
 * and they are different: fold puts it out of the way and keeps it, close takes it away
 * through the same registered command the activity button runs, so the button's lit state
 * and the panel's existence cannot come apart.
 */
function AnnotationsSidebar(): JSX.Element {
  const { run } = useWorkspace();
  const state = useWorkspaceState();
  const minimized = state.chrome.minimized.annotations;

  return (
    <>
      {!minimized && <ChromeResizer panel="annotations" testId="resize-annotations-sidebar" />}
      <aside
        className={
          minimized
            ? 'wr-sidebar wr-sidebar--right wr-sidebar--folded'
            : 'wr-sidebar wr-sidebar--right'
        }
        data-testid="annotations-sidebar"
        data-minimized={minimized ? 'true' : 'false'}
        style={{ width: `${String(chromeExtent(state.chrome, 'annotations'))}px` }}
      >
        <div className="wr-sidebar__title">
          <span className="wr-sidebar__name">Annotations</span>
          <MinimizeControl
            panel="annotations"
            testId="minimize-annotations-sidebar"
            what="the annotations panel"
          />
          {/* The rail is one control wide, and the one it keeps is the one that brings the
              panel back. Two of them in thirty pixels overflowed the rail and put the second
              button over the document — a control drawn outside the panel it belongs to. */}
          {!minimized && (
            <button
              type="button"
              className="wr-button wr-button--icon"
              title="Close the annotations panel"
              aria-label="Close the annotations panel"
              data-testid="close-annotations-sidebar"
              onClick={() => void run(COMMAND_IDS.toggleAnnotationSidebar)}
            >
              ✕
            </button>
          )}
        </div>
        {!minimized && <AnnotationsView testId="annotations-list" />}
      </aside>
    </>
  );
}

const LEFT_SIDEBAR_TITLES: Readonly<Record<LeftSidebarName, string>> = {
  library: 'Library',
  // The queue's job is order — what to do next — and that is what it is called now. The
  // directory (`P01`) is where every notebook is; this is the short list in front.
  questions: 'What next',
};

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

/**
 * A glyph with its name under it.
 *
 * The glyph alone was a guessing game: ◫, ⌕, ◈ and ✎ are not icons anyone has learned, and
 * the only thing that said what they did was a tooltip you had to hover to find — so the
 * first thing a person did with this app was click all four to see what happened. The label
 * is rendered text rather than an `aria-label`, because a screen reader knowing the name is
 * not the same as the person looking at the screen knowing it.
 */
function ActivityButton({ label, glyph, active, testId, onClick }: ActivityButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={active ? 'wr-activity__button wr-activity__button--active' : 'wr-activity__button'}
      title={label}
      aria-pressed={active}
      data-testid={testId}
      onClick={onClick}
    >
      <span className="wr-activity__glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="wr-activity__label">{label}</span>
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
        label="Notebooks"
        glyph="▤"
        active={Object.values(state.panels).some((panel) => panel.kind === 'notebook-directory')}
        testId="activity-notebooks"
        onClick={() => void run(COMMAND_IDS.openNotebookDirectory)}
      />
      <ActivityButton
        label="What next"
        glyph="⌸"
        active={state.sidebars.questions}
        testId="activity-questions"
        onClick={() => void run(COMMAND_IDS.toggleQuestionsSidebar)}
      />
      {/* No notebook in hand, and none needed: the command asks the host which notebook the
          researcher is on, which is the same answer a keystroke gets (`D01`). */}
      <ActivityButton
        label="Journal"
        glyph="◷"
        // Lit for either home the journal has (`P09`): the sheet over the workspace and the
        // page it expands into are one journal, so a bar that only knew about the tab would go
        // dark the moment the thing it opened appeared.
        active={
          state.journalPopup !== null ||
          Object.values(state.panels).some((panel) => panel.kind === 'journal')
        }
        testId="activity-journal"
        onClick={() => void run(COMMAND_IDS.openJournal)}
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
      {/* Two doors into one surface (`F05`): the whole library, and the same page focused on
          the file in front of you. Lit for either state, because a bar that only knew about
          the whole map would go dark the moment the researcher crawled into it. */}
      <ActivityButton
        label="Wiki"
        glyph="⬡"
        active={Object.values(state.panels).some((panel) => panel.kind === 'wiki')}
        testId="activity-wiki"
        onClick={() => void run(COMMAND_IDS.openWiki)}
      />
      {/* Unconditional, the way the Graph button is (`U05`): with nothing open the command
          says what would make it work rather than the button being unreachable. */}
      <ActivityButton
        label="Focus"
        glyph="◎"
        active={Object.values(state.panels).some(
          (panel) => panel.kind === 'wiki' && panel.focusDocumentId !== null,
        )}
        testId="activity-focus"
        onClick={() => void run(COMMAND_IDS.openFocusView)}
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
  const { store, host } = useWorkspace();
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
        if (panel === undefined) {
          store.update({ activePanelId: null });
          return;
        }
        // Every reader kind, through the host's one rule. Naming `pdf-reader` here meant a
        // saved page or a markdown file could be the tab in front of the researcher while the
        // rest of the app was still pointed at the last PDF.
        host.activatePanel(panel.id);
      });
      // A layout that arrived before Dockview was ready is parked in the store.
      applyPendingLayout(event.api, store);
    },
    [host, store],
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
        defaultTabComponent={WorkspaceTab}
        onReady={onReady}
        watermarkComponent={Watermark}
      />
    </div>
  );
}

/**
 * What a right-click on a tab is about (`R01`).
 *
 * A tab is two things at once: a *panel*, which can be closed with its group whatever it holds,
 * and whatever it is *showing*, which may be a file with a ledger and a graph and a desk to be
 * sent to. Both are answered here, and `menus.ts` decides which of them this tab can offer —
 * the help tab has no entity and is left with the two close items, and nothing has to be
 * special-cased for it.
 */
function tabMenuArgs(
  panelId: string,
  groupId: string | null,
  descriptor: PanelDescriptor | null,
): Record<string, unknown> {
  const panel = { panelId, ...(groupId === null ? {} : { groupId }) };
  if (descriptor === null) return panel;
  if (isReaderPanel(descriptor)) {
    return {
      ...panel,
      ...entityMenuArgs({
        entityId: descriptor.documentId,
        entityType: 'document',
        documentId: descriptor.documentId,
      }),
    };
  }
  if (descriptor.kind === 'note-editor') {
    return { ...panel, ...entityMenuArgs({ entityId: descriptor.noteId, entityType: 'note' }) };
  }
  return panel;
}

/**
 * Dockview's own tab, with a right-click on it.
 *
 * Wrapping rather than reimplementing: `DockviewDefaultTab` spreads unknown props onto its root
 * element, so the handler lands on the real tab and the markup — `.dv-default-tab-content`, the
 * close control every tab test reaches for — is Dockview's own, unchanged.
 */
function WorkspaceTab(props: IDockviewPanelHeaderProps): JSX.Element {
  const { store } = useWorkspace();
  const openMenu = useOpenContextMenu();
  return (
    <DockviewDefaultTab
      {...props}
      onContextMenu={(event) => {
        const descriptor = store.panel(props.api.id);
        openMenu(event, 'tab', tabMenuArgs(props.api.id, props.api.group.id, descriptor));
      }}
    />
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

/**
 * What the centre shows when nothing is open.
 *
 * This is the first screen of a fresh install and the screen after the last tab closes, and it
 * used to be one sentence pointing at a sidebar that may not be showing. An empty workspace is
 * the one place where naming the ways in costs nothing, so it names them and offers them: the
 * shelf of notebooks, the whole graph, a file by name. Each is the same registered command a
 * keystroke runs, with the keystroke printed beside it, so using the mouse here is also how
 * the chord is learned.
 */
function Watermark(): JSX.Element {
  const { workbench, run } = useWorkspace();
  const ways = [
    { commandId: COMMAND_IDS.openNotebookDirectory, label: 'Open the notebooks' },
    { commandId: COMMAND_IDS.goToFile, label: 'Go to a file' },
    { commandId: COMMAND_IDS.openWiki, label: 'Open the wiki' },
  ];

  return (
    <div className="wr-watermark" data-testid="workspace-watermark">
      <p className="wr-watermark__message">Nothing open.</p>
      <div className="wr-watermark__ways">
        {ways.map((way) => {
          const chord = workbench.keybindings.chordsForCommand(way.commandId)[0];
          return (
            <button
              key={way.commandId}
              type="button"
              className="wr-button"
              data-testid={`watermark-${way.commandId}`}
              onClick={() => void run(way.commandId)}
            >
              {way.label}
              <Chord chord={chord} platform={workbench.keybindings.platform} />
            </button>
          );
        })}
      </div>
      <p className="wr-watermark__hint">
        Everything the app can do is on the help page, and every keystroke with it.
      </p>
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
  const minimized = state.chrome.minimized.bottom;

  return (
    <>
      {!minimized && <ChromeResizer panel="bottom" testId="resize-bottom-panel" />}
      <section
        className={minimized ? 'wr-bottom wr-bottom--folded' : 'wr-bottom'}
        data-testid="bottom-panel"
        data-minimized={minimized ? 'true' : 'false'}
        style={{ height: `${String(chromeExtent(state.chrome, 'bottom'))}px` }}
      >
        <Panel
          title={title}
          testId="bottom-panel-body"
          toolbar={
            <>
              <MinimizeControl
                panel="bottom"
                testId="minimize-bottom-panel"
                what="the panel below"
              />
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
            </>
          }
        >
          {!minimized && <ReferencesView testId="references-list" />}
        </Panel>
      </section>
    </>
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

/**
 * One context key, read live.
 *
 * The context service is what a `when` clause is evaluated against, so a control that reads a
 * key here is gated on exactly what gates the keystroke — not on a second calculation that can
 * be right today and wrong after the next command is added. It publishes its own changes, which
 * is why this is a `useSyncExternalStore` and not a value recomputed on the store's commits:
 * the history is not in the store, and a Back button that is stale-disabled would be worse than
 * one that is always enabled.
 */
function useContextKey(key: string): boolean {
  const { workbench } = useWorkspace();
  return useSyncExternalStore(
    useCallback(
      (onChange: () => void) => workbench.contextKeys.onDidChange(onChange),
      [workbench],
    ),
    () => workbench.contextKeys.get(key) === true,
  );
}

function StatusBar(): JSX.Element {
  const { workbench, run } = useWorkspace();
  const state = useWorkspaceState();
  const status = state.status;
  const openCount = Object.keys(state.panels).length;

  // The way in to `K03`, and the reason it is in the status bar rather than behind a chord:
  // a list of every keyboard shortcut that can only be opened with a keyboard shortcut is not
  // discoverable. It shows its own chord, so finding it once is how you learn the key.
  const commandsChord = workbench.keybindings.chordsForCommand(COMMAND_IDS.showCommands)[0];
  // And the help page beside it, for the same reason at a larger size (`D02`): the page that
  // explains the scheme cannot be reachable only through the scheme.
  const helpChord = workbench.keybindings.chordsForCommand(COMMAND_IDS.openHelp)[0];
  // And the guide beside *that*, first of the three, because it is the one that answers the
  // question someone arrives with. Help is a reference and a reference needs you to already
  // know the word you are looking up (`O01`).
  const guideChord = workbench.keybindings.chordsForCommand(COMMAND_IDS.openGuide)[0];
  const backChord = workbench.keybindings.chordsForCommand(COMMAND_IDS.goBack)[0];
  const forwardChord = workbench.keybindings.chordsForCommand(COMMAND_IDS.goForward)[0];
  const canGoBack = useContextKey('canGoBack');
  const canGoForward = useContextKey('canGoForward');

  return (
    <footer className="wr-status" data-testid="status-bar">
      <button
        type="button"
        className="wr-status__button"
        data-testid="status-commands"
        onClick={() => void run(COMMAND_IDS.showCommands)}
      >
        Commands
        <Chord chord={commandsChord} platform={workbench.keybindings.platform} />
      </button>
      <button
        type="button"
        className="wr-status__button"
        data-testid="status-guide"
        onClick={() => void run(COMMAND_IDS.openGuide)}
      >
        Guide
        <Chord chord={guideChord} platform={workbench.keybindings.platform} />
      </button>
      <button
        type="button"
        className="wr-status__button"
        data-testid="status-help"
        onClick={() => void run(COMMAND_IDS.openHelp)}
      >
        Help
        <Chord chord={helpChord} platform={workbench.keybindings.platform} />
      </button>
      {/* The two buttons read the *same* context key their chords are gated on, so a control
          that is offered and a key that works can never disagree. Both are live: `Workbench`
          writes `canGoBack`/`canGoForward` into the context service on every navigation, and
          the service publishes changes — so this does not depend on a store commit happening
          to arrive at the same moment. A button that is always available and sometimes inert
          teaches you to distrust the whole bar. */}
      <StatusAction
        label="Back"
        testId="status-back"
        chord={backChord}
        platform={workbench.keybindings.platform}
        enabled={canGoBack}
        hint="Back to where you were"
        disabledHint="Nothing to go back to yet — this is the first place you have been."
        onClick={() => void workbench.commands.execute(COMMAND_IDS.goBack, {}, workbench.context())}
      />
      <StatusAction
        label="Forward"
        testId="status-forward"
        chord={forwardChord}
        platform={workbench.keybindings.platform}
        enabled={canGoForward}
        hint="Forward again, along the way you came back"
        disabledHint="Nothing ahead — you have not gone back from anywhere."
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

/**
 * A status-bar action that says whether it can do anything.
 *
 * Disabled is the honest state, and the reason for it is on the button rather than only in the
 * grey: `title` says *why* there is nowhere to go, so the answer is where the pointer already
 * is. The chord rides along for the reason the three pages beside it print theirs — the mouse
 * is also how the keyboard gets learned.
 */
function StatusAction({
  label,
  testId,
  chord,
  platform,
  enabled,
  hint,
  disabledHint,
  onClick,
}: {
  readonly label: string;
  readonly testId: string;
  readonly chord: string | undefined;
  readonly platform: Platform;
  readonly enabled: boolean;
  readonly hint: string;
  readonly disabledHint: string;
  readonly onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="wr-status__button"
      data-testid={testId}
      data-enabled={enabled ? 'true' : 'false'}
      disabled={!enabled}
      title={enabled ? hint : disabledHint}
      onClick={onClick}
    >
      {label}
      <Chord chord={chord} platform={platform} />
    </button>
  );
}
