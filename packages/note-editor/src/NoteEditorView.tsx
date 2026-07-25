import { useCallback, useEffect, useMemo, useRef } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { parseInternalLink } from '@wr/document-model';
import type { InternalLink } from '@wr/shared-types';
import { EmbeddedExcerptNode } from './embedded-excerpt-node.js';
import {
  AnnotationLinkNode,
  DocumentLinkNode,
  NoteLinkNode,
} from './internal-link-node.js';
import { flattenNoteText } from './note-content.js';

export interface NoteEditorViewProps {
  readonly noteId: string;
  readonly title: string;
  /** ProseMirror JSON. `null` for a note that has never been written to. */
  readonly content: unknown;
  readonly onTitleChange: (title: string) => void;
  /** Debounced by the caller: this fires on every keystroke. */
  readonly onContentChange: (content: unknown, text: string) => void;
  /** A link chip gained or lost pointer/keyboard focus. `null` means "nothing now". */
  readonly onLinkHover?: (link: InternalLink | null) => void;
  /** A chip was activated directly, by click or Enter. */
  readonly onLinkActivate?: (link: InternalLink) => void;
  /** An embedded excerpt was activated: navigate to the annotation it quotes. */
  readonly onExcerptActivate?: (annotationId: string) => void;
}

const EXTENSIONS = [
  StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
  DocumentLinkNode,
  AnnotationLinkNode,
  NoteLinkNode,
  EmbeddedExcerptNode,
];

function linkFromEvent(target: EventTarget | null): InternalLink | null {
  if (!(target instanceof HTMLElement)) return null;
  const anchor = target.closest('[data-internal-link]');
  const href = anchor?.getAttribute('data-internal-link') ?? null;
  return href === null ? null : parseInternalLink(href);
}

function excerptIdFromEvent(target: EventTarget | null): string | null {
  if (!(target instanceof HTMLElement)) return null;
  return target.closest('[data-embedded-excerpt]')?.getAttribute('data-embedded-excerpt') ?? null;
}

/**
 * The note editor.
 *
 * Tiptap owns the text. This component owns the two things Tiptap does not: keeping the
 * plain-text projection in step with the JSON on every change, and reporting which internal
 * link the pointer is over — which is what makes F12 ("go to the target under the cursor")
 * work inside a note rather than only in the panels that list links.
 */
export function NoteEditorView({
  noteId,
  title,
  content,
  onTitleChange,
  onContentChange,
  onLinkHover,
  onLinkActivate,
  onExcerptActivate,
}: NoteEditorViewProps): JSX.Element {
  // Kept in a ref so the Tiptap `onUpdate` closure, created once per editor, always calls
  // the current handler instead of the one that existed when the note was opened.
  const changeRef = useRef(onContentChange);
  changeRef.current = onContentChange;

  const initialContent = useMemo(
    () => (content === null || content === undefined ? { type: 'doc', content: [] } : content),
    // Only when the note itself changes: re-feeding content on every render would fight
    // the user's cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [noteId],
  );

  const editor = useEditor(
    {
      extensions: EXTENSIONS,
      content: initialContent,
      editorProps: {
        attributes: {
          class: 'wr-note__body',
          'data-testid': 'note-editor-body',
        },
      },
      onUpdate: ({ editor: instance }) => {
        const json = instance.getJSON();
        changeRef.current(json, flattenNoteText(json));
      },
    },
    [noteId],
  );

  const handleMouseOver = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      onLinkHover?.(linkFromEvent(event.target));
    },
    [onLinkHover],
  );

  const handleMouseLeave = useCallback(() => onLinkHover?.(null), [onLinkHover]);

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const link = linkFromEvent(event.target);
      if (link !== null) {
        event.preventDefault();
        onLinkActivate?.(link);
        return;
      }
      const annotationId = excerptIdFromEvent(event.target);
      if (annotationId !== null && annotationId.length > 0) onExcerptActivate?.(annotationId);
    },
    [onLinkActivate, onExcerptActivate],
  );

  // Focus follows the caret through chips, so keyboard users get the same F12 target a
  // mouse user gets by hovering.
  useEffect(() => {
    if (editor === null) return;
    const report = (): void => {
      const { state } = editor;
      const node = state.doc.nodeAt(state.selection.from);
      const href = node?.attrs['href'];
      onLinkHover?.(typeof href === 'string' ? parseInternalLink(href) : null);
    };
    editor.on('selectionUpdate', report);
    return () => {
      editor.off('selectionUpdate', report);
    };
  }, [editor, onLinkHover]);

  return (
    <div className="wr-note" data-testid="note-editor" data-note-id={noteId}>
      <input
        className="wr-note__title"
        data-testid="note-title"
        value={title}
        aria-label="Note title"
        onChange={(event) => onTitleChange(event.target.value)}
      />
      <div
        className="wr-note__content"
        onMouseOver={handleMouseOver}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
      >
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
