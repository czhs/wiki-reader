import { formatInternalLink } from '@wr/document-model';
import type { AnnotationId, AnnotationWithAnchor, DocumentId } from '@wr/shared-types';
import { embeddedExcerptJson } from './embedded-excerpt-node.js';
import { internalLinkNodeJson } from './internal-link-node.js';

/**
 * Note content, built and flattened without an editor instance.
 *
 * Two callers need this outside the editor: the "attach a note to this highlight" command,
 * which composes a note before any editor exists, and every save, which has to send a
 * plain-text projection alongside the JSON. The projection is not cosmetic — it is what
 * FTS5 indexes and what the main process scans to re-derive typed links, so it has to
 * contain the canonical `annotation://…` URLs rather than the chips' human labels.
 */

/** A ProseMirror JSON node. Structural only: attribute shapes belong to each node module. */
export interface NoteContentNode {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly content?: readonly NoteContentNode[];
  readonly text?: string;
}

export interface NoteContent {
  readonly type: 'doc';
  readonly content: readonly NoteContentNode[];
}

function attr(node: NoteContentNode, key: string): string {
  const value = node.attrs?.[key];
  return typeof value === 'string' ? value : '';
}

/** Blocks that should end up on their own line in the plain-text projection. */
const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'embeddedExcerpt',
  'listItem',
  'codeBlock',
]);

/**
 * Flatten note JSON the same way the editor's own text serializer would.
 *
 * Kept deliberately total: unknown node types contribute their children rather than
 * throwing, because a note written by a newer version of the app must still be indexable
 * by an older one instead of failing to save.
 */
export function flattenNoteText(content: unknown): string {
  const pieces: string[] = [];

  const walk = (node: NoteContentNode): void => {
    if (node.type === 'text') {
      pieces.push(node.text ?? '');
      return;
    }
    if (node.type === 'documentLink' || node.type === 'annotationLink' || node.type === 'noteLink') {
      pieces.push(attr(node, 'href'));
      return;
    }
    if (node.type === 'embeddedExcerpt') {
      pieces.push(attr(node, 'fallbackText'), '\n');
      return;
    }
    for (const child of node.content ?? []) walk(child);
    if (BLOCK_TYPES.has(node.type)) pieces.push('\n');
  };

  const root = content as NoteContentNode | null;
  if (root === null || typeof root !== 'object' || typeof root.type !== 'string') return '';
  walk(root);
  return pieces.join('').replace(/\n{3,}/g, '\n\n').trim();
}

export interface AnnotationNoteInput {
  readonly annotation: AnnotationWithAnchor;
  readonly documentId: DocumentId;
  readonly documentTitle: string;
}

/**
 * The starting content for a note attached to a highlight.
 *
 * The note opens with the highlight embedded and a link back to it, so the note is
 * readable on its own and the relationship is visible in the text rather than only in the
 * links table. An empty paragraph follows: the user's cursor has somewhere to land.
 */
export function noteContentForAnnotation(input: AnnotationNoteInput): NoteContent {
  const { annotation, documentId, documentTitle } = input;
  const annotationId: AnnotationId = annotation.id;
  const page =
    annotation.anchor.kind === 'pdf' ? ` p. ${String(annotation.anchor.pageIndex + 1)}` : '';

  return {
    type: 'doc',
    content: [
      embeddedExcerptJson(annotationId, annotation.selectedText),
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'From ' },
          internalLinkNodeJson({ scheme: 'document', documentId }, `${documentTitle}${page}`),
          { type: 'text', text: ' — ' },
          internalLinkNodeJson({ scheme: 'annotation', annotationId }, 'the highlight'),
        ],
      },
      { type: 'paragraph' },
    ],
  };
}

/** The title a new highlight note gets: the first words of the highlight. */
export function noteTitleForAnnotation(annotation: AnnotationWithAnchor): string {
  const words = annotation.selectedText.trim().split(/\s+/).slice(0, 8).join(' ');
  return words.length === 0 ? 'Note' : words;
}

/** The canonical URL for an annotation, used when a chip is inserted by command. */
export function annotationLinkUrl(annotationId: AnnotationId): string {
  return formatInternalLink({ scheme: 'annotation', annotationId });
}
