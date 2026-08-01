/**
 * The block editor (criteria N11, P04, P05, S01, S02).
 *
 * One writing surface, used by both places the researcher writes: a journal day, which is
 * notes to oneself, and a notebook's page, which is where a paper gets written. It was
 * ~140 lines welded into `JournalView`; the notebook needed the same thing, and a second copy
 * is how the duplicates this tree has already folded back got started.
 *
 * What it is: a vertical sequence of markdown blocks you click into one at a time. Blocks are
 * a **view over one markdown document** — `block-source.ts` parses them out and puts them
 * back — so there is no block store and nothing that can drift from the document. Text blocks
 * render through the corpus renderer, which builds React elements and never an HTML string,
 * so what is written cannot inject markup into the app's origin; that renderer is also where
 * LaTeX (`S02`) and `[[wikilinks]]` come from, and both light up here for free.
 *
 * What it deliberately is not: Jupyter. Nothing executes. A code block is a command or a
 * snippet somebody jotted down, kept as the text they typed.
 *
 * Three rules it keeps:
 *
 * - **The document is the authority.** `value` in, `onCommit(markdown)` out. The owner writes
 *   it wherever it lives and hands back what was stored; the editor re-parses that. A block
 *   edited into a fence comes back as code, a block emptied disappears.
 * - **A click puts the caret where it landed** (`P05`), not at the start of the box.
 * - **A change arriving from outside does not eat an unsaved block** (the milestone-5 audit's
 *   picture-drop bug). `mergeAppend` reconciles the two; see `block-source.ts`.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { renderMarkdown, type InternalLinkRenderer } from '@wr/markdown-reader';
import { AnnotationIdSchema, DocumentIdSchema, NoteIdSchema } from '@wr/shared-types';
import {
  classify,
  codeBody,
  codeLanguage,
  mergeAppend,
  parseBlocks,
  serializeBlocks,
  sourceOffsetFor,
  EMPTY_CODE_BLOCK,
  type Block,
} from './block-source.js';
import { registerBlockSurface, touchBlockSurface } from './block-surfaces.js';
import { useOpenContextMenu } from './context-menu.js';
import { useWorkspace } from './workspace.js';

/**
 * A block on screen: what it is, plus a key that survives editing.
 *
 * The key is not the index. Blocks are re-parsed out of the stored markdown after every
 * write, and keying by index makes React reuse the textarea of a block that has become a
 * different one — so the caret lands in the wrong place after an edit that changed how many
 * blocks there are.
 */
interface BlockRow extends Block {
  readonly key: number;
}

/** Which block is open, and where in it the caret should be (`P05`). */
interface Editing {
  readonly index: number;
  readonly offset: number;
}

let keySeq = 0;
const nextKey = (): number => {
  keySeq += 1;
  return keySeq;
};

const toRows = (blocks: readonly Block[]): BlockRow[] =>
  blocks.map((block) => ({ ...block, key: nextKey() }));

/**
 * Where in a block's markdown a click landed.
 *
 * `caretRangeFromPoint` is what the browser already uses to place a caret in text, so the
 * answer is the one the reader saw under their finger rather than a guess from a bounding
 * box. It answers in the *rendered* text; `sourceOffsetFor` carries that back to the source.
 * A click that lands on no text at all — the padding around a paragraph — falls back to the
 * end of the block, which is where someone clicking past the last word means to be.
 */
function offsetFromClick(element: HTMLElement, src: string, x: number, y: number): number {
  const rendered = element.textContent ?? '';
  const range = document.caretRangeFromPoint(x, y);
  if (range === null || !element.contains(range.startContainer)) return src.length;
  const upto = document.createRange();
  upto.selectNodeContents(element);
  upto.setEnd(range.startContainer, range.startOffset);
  return sourceOffsetFor(src, rendered, upto.toString().length);
}

/**
 * One block, rendered.
 *
 * Text and images go through the corpus renderer, which builds React elements from the mdast
 * and never an HTML string. An image resolves through `rrfile://` like every other byte — the
 * window's `img-src` allows nothing else, so a pasted remote URL renders as a broken image
 * rather than as a request.
 *
 * Code is drawn here rather than by the renderer because a command is source: it keeps its
 * whitespace, and it is what the journal's commands margin lists.
 */
export function BlockBody({
  block,
  internalLinks,
}: {
  readonly block: Block;
  readonly internalLinks?: InternalLinkRenderer | undefined;
}): JSX.Element {
  if (block.type === 'code') {
    const language = codeLanguage(block.src);
    return (
      <pre className="wr-block__code" data-language={language ?? ''}>
        <code>{codeBody(block.src)}</code>
      </pre>
    );
  }
  if (block.src.trim() === '') {
    return <span className="wr-block__placeholder">Empty block</span>;
  }
  return <>{renderMarkdown(block.src, internalLinks === undefined ? {} : { internalLinks })}</>;
}

/** What an owner can ask the editor to do without owning its state. */
export interface BlockEditorHandle {
  /** Open a block for editing, with the caret at `offset` (defaults to its end). */
  readonly open: (index: number, offset?: number) => void;
  /** Add a block at the end and open it. */
  readonly insert: (src: string) => void;
  /**
   * Add a block *after* `index` and open it. `null` appends, which is what `insert` does.
   *
   * The one thing the insert strip at the bottom cannot say: a right-click knows which block it
   * happened on, so "add a text block" there means here rather than at the end of the page
   * (`R01`).
   */
  readonly insertAfter: (index: number | null, src: string) => void;
  /** Write the document now, without closing the block being typed in (`P12`). */
  readonly save: () => void;
}


export interface BlockEditorProps {
  /**
   * What this surface is called, so a command can name it: `notebook:<id>`, `journal:<id>`.
   * Unique per mounted surface — two notebook pages can be open at once.
   */
  readonly surfaceId: string;
  /** The markdown document this is a view over. */
  readonly value: string;
  /**
   * Write it. The owner stores it and answers with what was stored — which the editor takes
   * as the new document, so a write that normalized something is what ends up on screen.
   */
  readonly onCommit: (markdown: string) => Promise<string> | string;
  /** `journal` or `notebook`: every testid below is prefixed with it. */
  readonly testIdPrefix: string;
  /** What a block's textarea is called to a screen reader. */
  readonly ariaLabel: (index: number) => string;
  /** What the surface says when nothing is written yet. */
  readonly emptyMessage: string;
  /** The label on the explicit save button; blurring commits either way. */
  readonly saveLabel: string;
  /** The drop attribute the preload reads, if this surface accepts pictures. */
  readonly dropAttribute?: { readonly name: string; readonly value: string } | undefined;
  /** Extra controls in the insert strip — the notebook's `Insert excerpt…` (`S03`). */
  readonly extraControls?: ReactNode;
}

export const BlockEditor = forwardRef<BlockEditorHandle, BlockEditorProps>(function BlockEditor(
  {
    surfaceId,
    value,
    onCommit,
    testIdPrefix,
    ariaLabel,
    emptyMessage,
    saveLabel,
    dropAttribute,
    extraControls,
  },
  ref,
): JSX.Element {
  const { workbench } = useWorkspace();
  const openMenu = useOpenContextMenu();
  /**
   * An `annotation://` link in a block goes to the marked sentence (`S03`). The same
   * navigation every citation in the app uses, so an excerpt is a way back into the reading
   * rather than a decoration on a quote.
   */
  const internalLinks = useMemo<InternalLinkRenderer>(
    () => ({
      activate: (link) => {
        if (link.scheme === 'annotation') {
          const parsed = AnnotationIdSchema.safeParse(link.annotationId);
          if (!parsed.success) return;
          void workbench.navigate({ entityId: parsed.data, entityType: 'annotation' }, 'current');
          return;
        }
        if (link.scheme === 'document') {
          const parsed = DocumentIdSchema.safeParse(link.documentId);
          if (!parsed.success) return;
          void workbench.navigate(
            { entityId: parsed.data, entityType: 'document', documentId: parsed.data },
            'current',
          );
          return;
        }
        const parsed = NoteIdSchema.safeParse(link.noteId);
        if (!parsed.success) return;
        void workbench.navigate({ entityId: parsed.data, entityType: 'note' }, 'current');
      },
    }),
    [workbench],
  );
  const [rows, setRows] = useState<readonly BlockRow[]>(() => toRows(parseBlocks(value)));
  const [editing, setEditing] = useState<Editing | null>(null);
  // The document these rows were parsed from. `value` changing away from it is a write that
  // happened somewhere else — another window, or the main process writing in a picture.
  const baseline = useRef(value);
  // Written during render on purpose: `commit` runs from a blur, which is a task of its own,
  // and it has to see the keystroke that caused the blur rather than the render before it.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    if (value === baseline.current) return;
    const mine = serializeBlocks(rowsRef.current);
    const merged = mergeAppend(baseline.current, mine, value);
    baseline.current = value;
    setRows(toRows(parseBlocks(merged)));
    setEditing(null);
  }, [value]);

  /**
   * Write the document, and take the blocks back from what was stored.
   *
   * The markdown is the authority, so the editor re-parses the document the owner answers
   * with rather than keeping its own idea of the blocks. That is what makes the block list a
   * *view*.
   */
  const commit = useCallback(async () => {
    setEditing(null);
    const markdown = serializeBlocks(rowsRef.current);
    if (markdown === baseline.current) return;
    const stored = await onCommit(markdown);
    baseline.current = stored;
    setRows(toRows(parseBlocks(stored)));
  }, [onCommit]);

  /**
   * Write the document without leaving the block (`P12`).
   *
   * `Cmd+S` is pressed *while typing*, which is the whole point of it: someone three
   * paragraphs into a section wants the last three paragraphs on disk, not the caret taken
   * away from them. So this is `commit` minus the two things that would move it — the block
   * stays open, and the rows are only re-parsed when the owner answers with markdown that is
   * not what was sent.
   *
   * `rowsRef` is written during render, so it already holds the keystroke that has not been
   * blurred yet. Nothing here has to force a blur, and forcing one is exactly what would make
   * the criterion pass while making the feature useless.
   */
  const save = useCallback(async () => {
    const markdown = serializeBlocks(rowsRef.current);
    if (markdown === baseline.current) return;
    const stored = await onCommit(markdown);
    baseline.current = stored;
    // Only when the store normalized something: re-parsing rebuilds every row, and a rebuilt
    // row is a textarea React has replaced, which takes the caret with it.
    if (stored !== markdown) setRows(toRows(parseBlocks(stored)));
  }, [onCommit]);

  const open = useCallback((index: number, offset?: number) => {
    setEditing({ index, offset: offset ?? rowsRef.current[index]?.src.length ?? 0 });
  }, []);

  /** Add a block at the end and open it: an inserted block is one you are about to type in. */
  const insert = useCallback((src: string) => {
    setRows((current) => {
      setEditing({ index: current.length, offset: src.length });
      return [...current, { key: nextKey(), type: classify(src), src }];
    });
  }, []);

  /** The same, at a place: the new block lands after `index` and opens there. */
  const insertAfter = useCallback((index: number | null, src: string) => {
    setRows((current) => {
      const at = index === null ? current.length : Math.min(index + 1, current.length);
      setEditing({ index: at, offset: src.length });
      const next = [...current];
      next.splice(at, 0, { key: nextKey(), type: classify(src), src });
      return next;
    });
  }, []);

  const handle = useMemo<BlockEditorHandle>(
    () => ({ open, insert, insertAfter, save: () => void save() }),
    [open, insert, insertAfter, save],
  );
  useImperativeHandle(ref, () => handle, [handle]);

  // Registered for as long as it is mounted, so a command can act on it by name. The last
  // surface registered is also the one in hand until something else is touched, which is what
  // makes the palette's copy of these commands work with no argument at all.
  useEffect(() => registerBlockSurface(surfaceId, handle), [handle, surfaceId]);

  const dropProps =
    dropAttribute === undefined ? {} : { [dropAttribute.name]: dropAttribute.value };

  return (
    <>
      {/*
        The drop target for a picture (`P04`). The attribute is read by the preload, which is
        the only place that can turn a dropped `File` into a path; the main process writes the
        image into the document. Nothing here ever sees a path.
      */}
      <div className="wr-blocks" data-testid={`${testIdPrefix}-blocks`} {...dropProps}>
        {rows.length === 0 && (
          <p className="wr-blocks__empty" data-testid={`${testIdPrefix}-blocks-empty`}>
            {emptyMessage}
          </p>
        )}
        {rows.map((row, index) =>
          editing?.index === index ? (
            <textarea
              key={row.key}
              className="wr-input wr-blocks__editor"
              aria-label={ariaLabel(index)}
              placeholder={row.type === 'code' ? 'A command, or a snippet' : 'Markdown'}
              data-testid={`${testIdPrefix}-block-editor-${String(index)}`}
              ref={(element) => {
                // Focus and caret together, in the ref rather than through `autoFocus`:
                // `autoFocus` lands the caret at 0, which is the whole of what `P05` is
                // about. Guarded by the current selection so re-renders while typing do not
                // drag the caret back to where the click was.
                if (element === null || document.activeElement === element) return;
                element.focus();
                const at = Math.min(editing.offset, element.value.length);
                element.setSelectionRange(at, at);
              }}
              value={row.src}
              onChange={(event) => {
                const src = event.target.value;
                setRows((current) =>
                  current.map((candidate, at) =>
                    at === index ? { ...candidate, src, type: classify(src) } : candidate,
                  ),
                );
              }}
              onBlur={() => void commit()}
            />
          ) : (
            <div
              key={row.key}
              className={`wr-block wr-block--${row.type}`}
              data-testid={`${testIdPrefix}-block-${String(index)}`}
              data-block-type={row.type}
              role="button"
              tabIndex={0}
              title="Click to edit this block"
              onClick={(event) => {
                touchBlockSurface(surfaceId);
                setEditing({
                  index,
                  offset: offsetFromClick(
                    event.currentTarget,
                    row.src,
                    event.clientX,
                    event.clientY,
                  ),
                });
              }}
              // What can be done to *this* block. `blockIndex` is why the menu's "add a text
              // block" means here rather than at the end (`R01`).
              onContextMenu={(event) => {
                touchBlockSurface(surfaceId);
                openMenu(event, 'block', { surfaceId, blockIndex: index });
              }}
              onKeyDown={(event) => {
                // Reached by the keyboard rather than by a click, so there is no point to
                // honour: the end of the block is where someone about to add a line means.
                if (event.key === 'Enter') setEditing({ index, offset: row.src.length });
              }}
            >
              <BlockBody block={row} internalLinks={internalLinks} />
            </div>
          ),
        )}
      </div>

      <div className="wr-blocks__insert">
        <button
          type="button"
          className="wr-button"
          data-testid={`${testIdPrefix}-add-text`}
          onClick={() => insert('')}
        >
          + text
        </button>
        <button
          type="button"
          className="wr-button"
          data-testid={`${testIdPrefix}-add-code`}
          onClick={() => insert(EMPTY_CODE_BLOCK)}
        >
          + code
        </button>
        {extraControls}
        {/* No `+ image` button: a picture arrives by being dropped, because the bytes have to
            come from the operating system and nothing in this world can ask for them. The
            hint says so rather than offering a button that cannot work. */}
        {dropAttribute !== undefined && (
          <span
            className="wr-blocks__hint"
            data-testid={`${testIdPrefix}-image-hint`}
            data-control="block.picture"
          >
            drop a picture to add one
          </span>
        )}
        <button
          type="button"
          className="wr-button wr-button--quiet"
          data-testid={`${testIdPrefix}-save`}
          onClick={() => void commit()}
        >
          {saveLabel}
        </button>
      </div>
    </>
  );
});
