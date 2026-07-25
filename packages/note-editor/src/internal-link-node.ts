import { Node, mergeAttributes } from '@tiptap/core';
import { formatInternalLink, parseInternalLink } from '@wr/document-model';
import type { InternalLink } from '@wr/shared-types';

/**
 * The internal-link nodes: `DocumentLink`, `AnnotationLink`, `NoteLink`.
 *
 * One implementation, three registrations. They differ only in which scheme they accept,
 * and the spec names them separately because the *user* distinguishes them — a note that
 * cites a paper is a different relationship from one that answers a highlight, and the
 * link's type is what makes "find all links of this type" a useful question.
 *
 * Each is an atomic inline node rather than a mark: the chip is one thing to select, delete
 * and navigate to, and its text is derived from the target rather than typed. The canonical
 * `document://…` URL is kept in an attribute *and* emitted into the node's text content, so
 * the link survives a round trip through plain text — which is how the main process
 * re-derives typed edges after an edit.
 */

// A type alias, not an interface: see `EmbeddedExcerptAttributes` — `NoteContentNode.attrs`
// is a `Record<string, unknown>`, which only aliases structurally satisfy.
export type InternalLinkAttributes = {
  readonly href: string;
  readonly label: string;
};

function attributesOf(node: { attrs: Record<string, unknown> }): InternalLinkAttributes {
  const href = typeof node.attrs['href'] === 'string' ? node.attrs['href'] : '';
  const label = typeof node.attrs['label'] === 'string' ? node.attrs['label'] : href;
  return { href, label };
}

interface InternalLinkNodeOptions {
  readonly name: string;
  readonly scheme: InternalLink['scheme'];
}

function createInternalLinkNode({ name, scheme }: InternalLinkNodeOptions): Node {
  return Node.create({
    name,
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,

    addAttributes() {
      return {
        href: { default: '' },
        label: { default: '' },
      };
    },

    parseHTML() {
      return [
        {
          tag: `a[data-internal-link][data-scheme="${scheme}"]`,
          getAttrs: (element: HTMLElement) => {
            const href = element.getAttribute('data-internal-link');
            if (href === null) return false;
            const parsed = parseInternalLink(href);
            // A chip whose URL no longer parses is not silently kept as decoration: it
            // would look like a working link and navigate nowhere.
            return parsed === null || parsed.scheme !== scheme
              ? false
              : { href, label: element.textContent ?? href };
          },
        },
      ];
    },

    renderHTML({ node }) {
      const { href, label } = attributesOf(node);
      return [
        'a',
        mergeAttributes({
          'data-internal-link': href,
          'data-scheme': scheme,
          class: 'wr-internal-link',
          // Not a real href: navigation happens through the command registry, and a live
          // href in a renderer document is a navigation the shell would have to block.
          role: 'link',
          tabindex: '0',
        }),
        label.length === 0 ? href : label,
      ];
    },

    renderText({ node }) {
      // The plain-text projection is what gets indexed and what link derivation scans, so
      // it carries the URL rather than the human label.
      return attributesOf(node).href;
    },
  });
}

export const DocumentLinkNode = createInternalLinkNode({
  name: 'documentLink',
  scheme: 'document',
});
export const AnnotationLinkNode = createInternalLinkNode({
  name: 'annotationLink',
  scheme: 'annotation',
});
export const NoteLinkNode = createInternalLinkNode({ name: 'noteLink', scheme: 'note' });

/** The node name that renders a given internal link. */
export function nodeNameForLink(link: InternalLink): string {
  switch (link.scheme) {
    case 'document':
      return 'documentLink';
    case 'annotation':
      return 'annotationLink';
    case 'note':
      return 'noteLink';
  }
}

/** A ProseMirror JSON node for one internal link, for building note content in code. */
export function internalLinkNodeJson(
  link: InternalLink,
  label: string,
): { type: string; attrs: InternalLinkAttributes } {
  return {
    type: nodeNameForLink(link),
    attrs: { href: formatInternalLink(link), label },
  };
}
