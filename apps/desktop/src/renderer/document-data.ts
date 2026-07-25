/**
 * Loading the things a reader panel needs before it can show a document.
 *
 * Kept out of the panel components because two of them are shared state: annotations and
 * their note counts are read by the annotation sidebar as well as by the reader, and two
 * independent fetches of the same list drift the moment one of them creates a highlight.
 * These hooks fetch once and publish into the workspace store, which is the single copy
 * every panel then renders from.
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  AnnotationWithAnchor,
  DocumentFileRef,
  DocumentLocation,
  LibraryItem,
} from '@wr/shared-types';
import { DocumentIdSchema } from '@wr/shared-types';
import { call, describeError, subscribe } from './ipc.js';
import { useWorkspace, useWorkspaceState } from './workspace.js';

/** The link type `note:create` writes when a note is attached to a highlight. */
const NOTE_ANNOTATION_LINK = 'note-references-annotation';

/**
 * The file a reader should display.
 *
 * `primary` is the imported original; a document can also carry snapshots and supplements,
 * and opening one of those instead of the paper itself would be surprising.
 */
export function primaryFile(item: LibraryItem): DocumentFileRef | null {
  return item.files.find((file) => file.role === 'primary') ?? item.files[0] ?? null;
}

export interface DocumentData {
  readonly item: LibraryItem | null;
  readonly file: DocumentFileRef | null;
  /** The persisted reading position, or null for a document opened for the first time. */
  readonly savedLocation: DocumentLocation | null;
  readonly loading: boolean;
  readonly error: string | null;
}

/**
 * Load one document's record, its file reference, and its saved reading position.
 *
 * The reading position is fetched once, on open: it is the *initial* location, and
 * re-reading it while the user scrolls would fight the scrolling.
 */
export function useDocumentData(documentId: string): DocumentData {
  const { store } = useWorkspace();
  const [item, setItem] = useState<LibraryItem | null>(null);
  const [savedLocation, setSavedLocation] = useState<DocumentLocation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const parsed = DocumentIdSchema.safeParse(documentId);
    if (!parsed.success) {
      setError(`Not a document id: ${documentId}`);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [{ item: loaded }, { position }] = await Promise.all([
          call('library:getDocument', { documentId: parsed.data }),
          call('document:getReadingPosition', { documentId: parsed.data }),
        ]);
        if (cancelled) return;
        setItem(loaded);
        setSavedLocation(position?.location ?? null);
        setError(null);
        store.rememberDocumentTitle(loaded.document.id, loaded.document.title);
      } catch (failure) {
        if (!cancelled) setError(describeError(failure).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [documentId, store]);

  return { item, file: item === null ? null : primaryFile(item), savedLocation, loading, error };
}

/**
 * Keep the store's annotation list for one document current, and return a refresh callback.
 *
 * Returned rather than fired automatically after a write, because the caller usually
 * already has the created annotation and wants to select it in the same commit.
 */
export function useAnnotations(documentId: string): {
  readonly annotations: readonly AnnotationWithAnchor[];
  readonly refresh: () => Promise<void>;
} {
  const { store } = useWorkspace();
  const state = useWorkspaceState();

  const refresh = useCallback(async () => {
    const parsed = DocumentIdSchema.safeParse(documentId);
    if (!parsed.success) return;
    try {
      const { annotations } = await call('annotation:listByDocument', {
        documentId: parsed.data,
      });
      store.setAnnotations(documentId, annotations);
    } catch (failure) {
      store.setStatus(describeError(failure).message, 'error');
    }
  }, [documentId, store]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { annotations: state.annotations[documentId] ?? [], refresh };
}

/**
 * Note counts for every annotation, refreshed whenever the library changes.
 *
 * One query for the whole link type rather than one per annotation: the sidebar needs the
 * count for every row it draws, and a per-row round trip would be a request per highlight.
 */
export function useNoteCounts(): () => Promise<void> {
  const { store } = useWorkspace();

  const refresh = useCallback(async () => {
    try {
      const { links } = await call('link:findByType', {
        type: NOTE_ANNOTATION_LINK,
        direction: 'both',
      });
      const counts = new Map<string, number>();
      for (const link of links) {
        // The note is the source and the annotation the target, so the annotation is the
        // end being counted.
        counts.set(link.targetId, (counts.get(link.targetId) ?? 0) + 1);
      }
      store.setNoteCounts(counts);
    } catch (failure) {
      store.setStatus(describeError(failure).message, 'error');
    }
  }, [store]);

  useEffect(() => {
    void refresh();
    return subscribe('library:changed', () => {
      void refresh();
    });
  }, [refresh]);

  return refresh;
}
