/**
 * @wr/note-editor — Tiptap note editing with typed internal links.
 *
 * The editor is where the link model becomes something a person can actually write. A note
 * is not free text with URLs in it: `DocumentLink`, `AnnotationLink` and `NoteLink` are
 * nodes, so the relationship survives editing, is navigable with F12, and is re-derivable
 * from the note's plain-text projection by the main process. `EmbeddedExcerpt` resolves a
 * highlight by id rather than duplicating its text.
 */
export { NoteEditorView, type NoteEditorViewProps } from './NoteEditorView.js';
export {
  AnnotationLinkNode,
  DocumentLinkNode,
  NoteLinkNode,
  internalLinkNodeJson,
  nodeNameForLink,
  type InternalLinkAttributes,
} from './internal-link-node.js';
export {
  EmbeddedExcerptNode,
  embeddedExcerptJson,
  type EmbeddedExcerptAttributes,
} from './embedded-excerpt-node.js';
export {
  annotationLinkUrl,
  flattenNoteText,
  noteContentForAnnotation,
  noteTitleForAnnotation,
  type AnnotationNoteInput,
  type NoteContent,
  type NoteContentNode,
} from './note-content.js';
