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
import {
  DEFAULT_WORKSPACE_NAME,
  Workbench,
  fromWorkspaceLayoutRecord,
  serializeWorkspace,
  toWorkspaceLayoutRecord,
  type OpenMode,
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
  /**
   * Documents taken out of the library, most recently first.
   *
   * Carried here rather than fetched where it is shown, because a removal is only reversible
   * if the researcher can find what they removed — and the sidebar is where they will look.
   */
  readonly removed: readonly LibraryItem[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => void;
}

/** `Document.source` for the three ingestion paths that produce library rows. */
const ZOTERO_SOURCE = 'zotero';
const CORPUS_SOURCE = 'corpus';
const LOCAL_SOURCE = 'local';

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
  const [removed, setRemoved] = useState<readonly LibraryItem[]>([]);
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
        const [zotero, corpus, local, gone] = await Promise.all([
          call('library:listDocuments', { source: ZOTERO_SOURCE }),
          call('library:listDocuments', { source: CORPUS_SOURCE }),
          call('library:listDocuments', { source: LOCAL_SOURCE }),
          call('library:listRemoved', {}),
        ]);
        if (cancelled) return;
        setItems(zotero.items);
        setNotes(corpus.items);
        setAdded(local.items);
        setRemoved(gone.items);
        setError(null);

        const everything = [...zotero.items, ...corpus.items, ...local.items];
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
      library: { items, notes, added, removed, loading, error, reload },
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
      removed,
      loading,
      error,
      reload,
      openDocument,
      run,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
