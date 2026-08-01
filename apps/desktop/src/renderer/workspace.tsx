/**
 * The renderer's composition root.
 *
 * One `WorkspaceStore`, one `Workbench`, one `DockviewWorkbenchHost`, created once and
 * shared through context. Panels never talk to each other: they read this state and run
 * commands, which is what keeps "open the annotation's document beside this one" a single
 * registry entry instead of a chain of callbacks between two panels.
 *
 * This module also owns the three things that must happen exactly once per window: the
 * library query, layout restore, and layout save.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { IDockviewPanelProps } from 'dockview';
import {
  DEFAULT_WORKSPACE_NAME,
  Workbench,
  fromWorkspaceLayoutRecord,
  serializeWorkspace,
  toWorkspaceLayoutRecord,
  type OpenMode,
  type PanelDescriptor,
  type Platform,
} from '@wr/workbench';
import type { DocumentId, LibraryItem } from '@wr/shared-types';
import { DockviewWorkbenchHost } from './host.js';
import { WorkspaceStore, type WorkspaceState } from './store.js';
import { call, describeError, subscribe } from './ipc.js';

/**
 * What the sidebar lists, kept apart by where it came from.
 *
 * The library *is* the Zotero library. Ingested markdown is the user's own writing about it,
 * and listing the two as peers made the sidebar unreadable — a paper and a note look the
 * same in a flat list, and there is no order that makes them comparable. `items` and `notes`
 * are separate queries against `source` rather than one list partitioned here, so the
 * distinction is the database's and not this component's.
 */
export interface LibraryData {
  /** Documents imported from Zotero. */
  readonly items: readonly LibraryItem[];
  /** Documents ingested from the markdown corpus. */
  readonly notes: readonly LibraryItem[];
  /** Files added straight from the disk — dropped on the library, or picked in the dialog. */
  readonly added: readonly LibraryItem[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => void;
}

/** `Document.source` for the three ingestion paths that produce library rows. */
const ZOTERO_SOURCE = 'zotero';
const CORPUS_SOURCE = 'corpus';
const LOCAL_SOURCE = 'local';
/**
 * The demo library's own tag (`B07`), listed beside the notes rather than in a section of
 * its own.
 *
 * Its papers are markdown ingested by the same importer the notes folder uses, so they belong
 * where markdown belongs — and a fourth heading saying "demo" would be a permanent piece of
 * chrome for something that exists only while this is being built. What makes them removable
 * is the tag, not where they are drawn.
 */
const DEMO_SOURCE = 'demo';

export interface WorkspaceApi {
  readonly store: WorkspaceStore;
  readonly workbench: Workbench;
  readonly host: DockviewWorkbenchHost;
  readonly library: LibraryData;
  /** Open a document, honouring the requested target group. */
  readonly openDocument: (documentId: DocumentId, mode: OpenMode) => Promise<void>;
  /** Run a registered command by id, reporting failures to the status bar. */
  readonly run: (commandId: string, args?: Readonly<Record<string, unknown>>) => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceApi | null>(null);

export function useWorkspace(): WorkspaceApi {
  const value = useContext(WorkspaceContext);
  if (value === null) throw new Error('renderer: useWorkspace called outside WorkspaceProvider');
  return value;
}

/** Subscribe to the whole workspace state. React re-renders on every commit. */
export function useWorkspaceState(): WorkspaceState {
  const { store } = useWorkspace();
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/** Dockview passes `{ panelId }`; everything else about a panel is looked up from the store. */
export interface PanelParams {
  readonly panelId: string;
}

/** What Dockview hands a panel component. Every entry in `DOCKVIEW_COMPONENTS` takes one. */
export type DockPanelProps = IDockviewPanelProps<PanelParams>;

/**
 * What this panel is showing, when it is showing the kind the component draws.
 *
 * Every panel component began with the same three lines — look the descriptor up by panel id,
 * check it is not missing, check its `kind` — written out nine times with nine slightly
 * different empty states. The check is the interesting part and it is identical everywhere: a
 * component is registered against one kind, and a panel whose descriptor says something else
 * (or has gone) has nothing for that component to draw. What each caller still decides is what
 * to *say* about it, which is why this answers null rather than rendering anything.
 *
 * Read from the descriptor rather than from panel state on purpose: the descriptor is what a
 * re-seat changes. `openFocusView` rewrites a wiki panel's descriptor under it (`F05`) and the
 * ledger is re-seated onto another file the same way, and this is how that change arrives.
 */
export function usePanelDescriptor<K extends PanelDescriptor['kind']>(
  panelId: string,
  kind: K,
): Extract<PanelDescriptor, { kind: K }> | null {
  const state = useWorkspaceState();
  const descriptor = state.panels[panelId] ?? null;
  if (descriptor === null || descriptor.kind !== kind) return null;
  // `kind` is a type parameter rather than a literal here, so the discriminated union does not
  // narrow on its own; the comparison above is the proof.
  return descriptor as Extract<PanelDescriptor, { kind: K }>;
}

function currentPlatform(): Platform {
  const agent = navigator.userAgent;
  if (agent.includes('Mac')) return 'mac';
  if (agent.includes('Windows')) return 'win';
  return 'linux';
}

/** How long the layout stays still before it is written back. */
const LAYOUT_SAVE_DEBOUNCE_MS = 400;

export function WorkspaceProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const store = useMemo(() => new WorkspaceStore(), []);
  const host = useMemo(() => new DockviewWorkbenchHost(store), [store]);
  const workbench = useMemo(
    () => new Workbench(host, { platform: currentPlatform() }),
    [host],
  );

  const [items, setItems] = useState<readonly LibraryItem[]>([]);
  const [notes, setNotes] = useState<readonly LibraryItem[]>([]);
  const [added, setAdded] = useState<readonly LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((value) => value + 1), []);

  // --- library ------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [zotero, corpus, local, demo] = await Promise.all([
          call('library:listDocuments', { source: ZOTERO_SOURCE }),
          call('library:listDocuments', { source: CORPUS_SOURCE }),
          call('library:listDocuments', { source: LOCAL_SOURCE }),
          call('library:listDocuments', { source: DEMO_SOURCE }),
        ]);
        if (cancelled) return;
        setItems(zotero.items);
        setNotes([...corpus.items, ...demo.items]);
        setAdded(local.items);
        setError(null);

        const everything = [...zotero.items, ...corpus.items, ...local.items, ...demo.items];
        for (const item of everything) {
          store.rememberDocumentTitle(item.document.id, item.document.title);
        }
        // A `[[slug]]` resolves against the documents that carry one, which is what corpus
        // ingestion mints. Built here rather than per reader panel: every open markdown view
        // asks the same question, and the answer changes only when the library does. It is
        // built from *both* lists — splitting the sidebar must not narrow what a wikilink
        // can reach.
        const targets: Record<string, { documentId: string; title: string }> = {};
        for (const item of everything) {
          const { slug, id, title } = item.document;
          if (slug !== null && targets[slug] === undefined) targets[slug] = { documentId: id, title };
        }
        store.setWikilinkTargets(targets);
      } catch (failure) {
        if (!cancelled) setError(describeError(failure).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadToken, store]);

  // An import or a new annotation changes counts in the sidebar; refetch rather than
  // trying to patch the list in place.
  useEffect(() => subscribe('library:changed', () => reload()), [reload]);

  const run = useCallback(
    async (commandId: string, args: Readonly<Record<string, unknown>> = {}) => {
      try {
        await workbench.refreshDerivedContext();
        await workbench.commands.execute(commandId, { ...args }, workbench.context());
      } catch (failure) {
        store.setStatus(describeError(failure).message, 'error');
      }
    },
    [store, workbench],
  );

  const openDocument = useCallback(
    async (documentId: DocumentId, mode: OpenMode) => {
      try {
        await workbench.navigate({ entityId: documentId, entityType: 'document', documentId }, mode);
      } catch (failure) {
        store.setStatus(describeError(failure).message, 'error');
      }
    },
    [store, workbench],
  );

  // --- layout restore -----------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { layout } = await call('workspace:loadLayout', { name: DEFAULT_WORKSPACE_NAME });
        if (cancelled) return;
        if (layout === null) {
          store.update({ layoutRestored: true });
          return;
        }
        const restored = fromWorkspaceLayoutRecord(layout);
        if (!restored.ok) {
          // A layout we cannot read is not worth failing the window over: start empty and
          // say so, rather than showing a blank workspace with no explanation.
          store.setStatus(`Could not restore the previous layout: ${restored.error}`, 'error');
          store.update({ layoutRestored: true });
          return;
        }
        store.applyRestoredWorkspace(restored.workspace);
        workbench.history.restore(restored.workspace.history);
      } catch (failure) {
        if (!cancelled) store.setStatus(describeError(failure).message, 'error');
        if (!cancelled) store.update({ layoutRestored: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store, workbench]);

  // --- layout save --------------------------------------------------------
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const persist = (): void => {
      const state = store.getSnapshot();
      const api = store.api;
      // Saving before the restore has landed would overwrite the user's layout with the
      // empty one this window started from.
      if (api === null || !state.layoutRestored) return;

      const workspace = serializeWorkspace({
        dockview: api.toJSON(),
        panels: state.panels,
        activePanelId: state.activePanelId,
        sidebars: state.sidebars,
        chrome: state.chrome,
        history: workbench.history.toJSON(),
      });
      void call('workspace:saveLayout', {
        name: DEFAULT_WORKSPACE_NAME,
        layout: workspace.dockview,
        panelState: toWorkspaceLayoutRecord(workspace, new Date().toISOString()).panelState,
      }).catch((failure: unknown) => {
        store.setStatus(describeError(failure).message, 'error');
      });
    };

    const schedule = (): void => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(persist, LAYOUT_SAVE_DEBOUNCE_MS);
    };

    const unsubscribe = store.subscribe(schedule);
    // A window closing between the last change and the debounce would lose that change.
    window.addEventListener('beforeunload', persist);
    return () => {
      unsubscribe();
      window.removeEventListener('beforeunload', persist);
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    };
  }, [store, workbench]);

  const value = useMemo<WorkspaceApi>(
    () => ({
      store,
      workbench,
      host,
      library: { items, notes, added, loading, error, reload },
      openDocument,
      run,
    }),
    [
      store,
      workbench,
      host,
      items,
      notes,
      added,
      loading,
      error,
      reload,
      openDocument,
      run,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
