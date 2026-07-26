/**
 * The three edits the highlight popover makes: recolour, comment, delete.
 *
 * These live apart from `panels.tsx` because the criterion is that a colour is changed *from
 * the popover*, and a test can only show that if it drives the same wiring the panel does.
 * When this logic was inline in `AnnotationsView`, the `[W11]` test wrote its own copy of the
 * handlers — so no-op'ing the panel's copy left all seven `[W11]` tests green. One definition,
 * used by both, is what makes that mutation fail.
 *
 * Kept free of React, dockview and the reader packages so it can be imported under jsdom;
 * `panels.tsx` cannot be, which is what pushed the test into duplicating it.
 *
 * The list is re-read after an edit rather than patched in place: the response to an update is
 * one annotation, and the sidebar shows the document's set — reading it back is what keeps a
 * delete, a recolour and a comment from each needing their own reducer.
 */
import {
  AnnotationIdSchema,
  DocumentIdSchema,
  type AnnotationWithAnchor,
  type HighlightColor,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
} from '@wr/shared-types';
import { describeError } from './ipc.js';

/** What the edits need from the app around them: a way to call, and a store to refresh. */
export interface AnnotationEditContext {
  readonly call: <K extends IpcChannel>(
    channel: K,
    request: IpcRequest<K>,
  ) => Promise<IpcResponse<K>>;
  readonly setAnnotations: (
    documentId: string,
    annotations: readonly AnnotationWithAnchor[],
  ) => void;
  readonly setStatus: (text: string, tone: 'error') => void;
}

/**
 * The edits, each resolving once the write and the re-read have settled.
 *
 * They return a promise so a test can await one; the panel discards it with `void`, because a
 * click handler that returned a promise would be a floating one at every call site.
 */
export interface AnnotationEdits {
  changeColor(annotationId: string, color: HighlightColor): Promise<void>;
  changeComment(annotationId: string, comment: string | null): Promise<void>;
  remove(annotationId: string): Promise<void>;
}

export function createAnnotationEdits(
  documentId: string,
  context: AnnotationEditContext,
): AnnotationEdits {
  /** Run one edit, re-read the document's annotations, and report a failure to the status bar. */
  async function run(edit: () => Promise<unknown>): Promise<void> {
    try {
      await edit();
      const doc = DocumentIdSchema.safeParse(documentId);
      if (!doc.success) return;
      const { annotations } = await context.call('annotation:listByDocument', {
        documentId: doc.data,
      });
      context.setAnnotations(documentId, annotations);
    } catch (failure) {
      context.setStatus(describeError(failure).message, 'error');
    }
  }

  return {
    async changeColor(annotationId, color) {
      const parsed = AnnotationIdSchema.safeParse(annotationId);
      if (!parsed.success) return;
      await run(() => context.call('annotation:update', { annotationId: parsed.data, color }));
    },
    async changeComment(annotationId, comment) {
      const parsed = AnnotationIdSchema.safeParse(annotationId);
      if (!parsed.success) return;
      await run(() => context.call('annotation:update', { annotationId: parsed.data, comment }));
    },
    async remove(annotationId) {
      const parsed = AnnotationIdSchema.safeParse(annotationId);
      if (!parsed.success) return;
      await run(() => context.call('annotation:delete', { annotationId: parsed.data }));
    },
  };
}
