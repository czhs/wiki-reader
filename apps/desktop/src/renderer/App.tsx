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
  COMMAND_IDS,
  isReaderPanel,
  type PanelDescriptor,
  type PanelKind,
  type Platform,
} from '@wr/workbench';
import { classNames } from '@wr/shared-ui';
import { DOCKVIEW_COMPONENTS } from './panels.js';
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
        <MainArea />
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
      className={classNames('wr-activity__button', active && 'wr-activity__button--active')}
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

/**
 * The activity bar: a launcher of tabs (`U15`).
 *
 * Every one of these opened either a column beside the reading or a page in the middle, and
 * which of the two it was was a fact about the surface's history rather than about the work.
 * They are all pages now, so the bar has one job — put a page in front — and one gesture, the
 * Library button's: press it again and the page is gone (`U14`). A lit button means open.
 */
function ActivityBar(): JSX.Element {
  const { run } = useWorkspace();
  const state = useWorkspaceState();
  const isOpen = (kind: PanelKind): boolean =>
    Object.values(state.panels).some((panel) => panel.kind === kind);

  return (
    <nav className="wr-activity" data-testid="activity-bar">
      <ActivityButton
        label="Library"
        glyph="◫"
        active={isOpen('library')}
        testId="activity-library"
        onClick={() => void run(COMMAND_IDS.toggleLibrarySidebar)}
      />
      <ActivityButton
        label="Notebooks"
        glyph="▤"
        active={isOpen('notebook-directory')}
        testId="activity-notebooks"
        onClick={() => void run(COMMAND_IDS.openNotebookDirectory)}
      />
      <ActivityButton
        label="What next"
        glyph="⌸"
        active={isOpen('queue')}
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
        active={isOpen('wiki')}
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
        active={isOpen('annotation-list')}
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
  const { store, host, run } = useWorkspace();
  const state = useWorkspaceState();
  const container = useRef<HTMLDivElement>(null);

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

  // A workspace with nothing in it opens on the library (`U15`). The activity bar launches
  // tabs now, so with no persisted layout there is no tab at all, and the app's front door
  // has to be the shelf the researcher's work comes off — not an empty centre.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    if (store.api === null || !state.layoutRestored || state.pendingLayout !== null) return;
    seeded.current = true;
    if (Object.keys(state.panels).length > 0) return;
    void run(COMMAND_IDS.toggleLibrarySidebar);
  }, [run, state.layoutRestored, state.panels, state.pendingLayout, store]);

  // Keep the tab in front inside the strip (`U13`).
  //
  // Dockview does not do this — there is no `scrollIntoView` and no `scrollLeft` write
  // anywhere in the library — so with more tabs than fit, opening one put it hundreds of
  // pixels past the strip's right edge with nothing on screen to bring it back. The strip
  // has its own scrollbar again in `shell.css`; this is the half that has to be code,
  // because only the app knows which tab just became the active one.
  useEffect(() => {
    const root = container.current;
    if (root === null || state.activePanelId === null) return;
    const active = root.querySelector('.dv-tabs-container > .dv-tab.dv-active-tab');
    if (!(active instanceof HTMLElement)) return;
    const strip = active.parentElement;
    if (strip === null) return;
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    if (left < strip.scrollLeft) strip.scrollLeft = left;
    else if (right > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = right - strip.clientWidth;
    }
  }, [state.activePanelId, state.panels]);

  return (
    <div className="wr-main" data-testid="dockview-container" ref={container}>
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
      // Which panel this tab is for, on the tab itself. Dockview's own markup says nothing
      // about identity, so without this the only way to name a tab is by the title it happens
      // to be showing — and two files can share a title.
      data-panel-id={props.api.id}
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
// Peek and the status bar
// ---------------------------------------------------------------------------

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
        className={classNames('wr-status__message', status?.tone === 'error' && 'wr-status__message--error')}
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
