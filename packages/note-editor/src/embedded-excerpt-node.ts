import { Node, mergeAttributes } from '@tiptap/core';
import type { AnnotationId } from '@wr/shared-types';

/**
 * `EmbeddedExcerpt` — a highlight quoted inside a note.
 *
 * The node stores the annotation *id* and nothing else that matters. The quoted text is
 * rendered from whatever the annotation says now, so re-reading a note shows the highlight
 * as it currently is rather than a copy that silently diverged. The annotation record still
 * keeps its own `selectedText` as it was at creation — that is the historical record; this
 * is the live view of it.
 *
 * `fallbackText` is written alongside so a note is still readable when the annotation has
 * been deleted, and so the plain-text projection that gets indexed contains the words the
 * user actually saw.
 */

// A type alias, not an interface: these attribute bags are embedded in `NoteContentNode`,
// whose `attrs` is `Record<string, unknown>`, and only aliases get an implicit index
// signature.
export type EmbeddedExcerptAttributes = {
  readonly annotationId: string;
  readonly fallbackText: string;
};

export const EmbeddedExcerptNode = Node.create({
  name: 'embeddedExcerpt',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      annotationId: { default: '' },
      fallbackText: { default: '' },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'blockquote[data-embedded-excerpt]',
        getAttrs: (element: HTMLElement) => {
          const annotationId = element.getAttribute('data-embedded-excerpt');
          return annotationId === null
            ? false
            : { annotationId, fallbackText: element.textContent ?? '' };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const annotationId =
      typeof node.attrs['annotationId'] === 'string' ? node.attrs['annotationId'] : '';
    const fallbackText =
      typeof node.attrs['fallbackText'] === 'string' ? node.attrs['fallbackText'] : '';
    return [
      'blockquote',
      mergeAttributes({
        'data-embedded-excerpt': annotationId,
        class: 'wr-excerpt',
      }),
      fallbackText,
    ];
  },

  renderText({ node }) {
    return typeof node.attrs['fallbackText'] === 'string' ? node.attrs['fallbackText'] : '';
  },
});

/** A ProseMirror JSON node embedding one annotation, for building note content in code. */
export function embeddedExcerptJson(
  annotationId: AnnotationId,
  selectedText: string,
): { type: 'embeddedExcerpt'; attrs: EmbeddedExcerptAttributes } {
  return {
    type: 'embeddedExcerpt',
    attrs: { annotationId, fallbackText: selectedText },
  };
}
