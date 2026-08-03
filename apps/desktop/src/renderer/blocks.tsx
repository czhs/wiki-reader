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
 *
 * Milestone 7 gave the surface the three gestures a document you actually write in needs, and
 * every one of them is still an edit of that one markdown document:
 *
 * - **A block is dragged into place and deleted** (`P07`). Order *is* the document, so a
 *   reorder is `moveBlock` plus a write; a delete is a row taken out and a write.
 * - **An empty surface opens with its first block ready** (`P08`) where the owner asks for it,
 *   which is what makes arriving on a new journal day the same act as starting to type.
 * - **A figure is resized by dragging its corner** (`P11`), and the width it lands on is
 *   written into the markdown — a title-slot word, readable by anything else that reads the
 *   file, with no second store to drift.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { renderMarkdown, type InternalLinkRenderer } from '@wr/markdown-reader';
import { AnnotationIdSchema, DocumentIdSchema, NoteIdSchema } from '@wr/shared-types';
import {
  classify,
  codeBody,
  codeLanguage,
  mergeAppend,
  moveBlock,
  parseBlocks,
  parseBlockImage,
  serializeBlocks,
  sourceOffsetFor,
  withBlockImageWidth,
  EMPTY_CODE_BLOCK,
  type Block,
  type BlockLanguage,
} from './block-source.js';
import { renderTypstTree, useTypstRender } from './typst-view.js';
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

/** Narrower than this and a figure is a smudge with a handle on it (`P11`). */
const MIN_FIGURE_WIDTH = 48;

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
 * Text goes through the corpus renderer, which builds React elements from the mdast and never
 * an HTML string. An image resolves through `rrfile://` like every other byte — the window's
 * `img-src` allows nothing else, so a pasted remote URL renders as a broken image rather than
 * as a request.
 *
 * Code and figures are drawn here rather than by the renderer, for the same reason in two
 * shapes: the block *is* the thing, so this surface owns how it looks. A command is source and
 * keeps its whitespace, and it is what the journal's commands margin lists. A figure carries a
 * width the researcher set by hand (`P11`), which lives in the markdown title slot and which
 * the corpus renderer would print as a tooltip — it is a fact about this block, not about the
 * document's prose, so it is read back out here.
 */
/**
 * A Typst block, compiled and drawn (`S04`).
 *
 * Its own component because compiling is a round trip and a hook cannot be called from a
 * branch. The tree comes back from the main process with the text still in it, which is what
 * keeps `offsetFromClick` — and therefore `P05` — working across the language change: the
 * caret is placed from `textContent`, and a typeset SVG has none.
 *
 * A block that does not compile shows the compiler's own sentence and the source underneath it.
 * Never a blank space: the researcher's paragraph is still there, and a page that answers a
 * missing `#let` by silently drawing nothing looks exactly like a page that ate the writing.
 */
function TypstBlockBody({
  block,
  questionId,
  internalLinks,
}: {
  readonly block: Block;
  readonly questionId: string | null;
  readonly internalLinks?: InternalLinkRenderer | undefined;
}): JSX.Element {
  const rendering = useTypstRender(block.src, { questionId });
  if (rendering.error !== null) {
    return (
      <div className="wr-block__typst-error" data-testid="block-typst-error">
        <p className="wr-block__typst-message">{rendering.error}</p>
        <pre className="wr-block__code">
          <code>{block.src}</code>
        </pre>
      </div>
    );
  }
  if (rendering.tree === null) {
    // What was typed, while the compiler answers. The source is the truth either way, so this
    // is the block rather than a spinner standing where the block should be.
    return <pre className="wr-block__typst-pending">{block.src}</pre>;
  }
  return (
    <>
      {renderTypstTree(rendering.tree, {
        ...(internalLinks === undefined ? {} : { activateInternal: internalLinks.activate }),
      })}
    </>
  );
}

function BlockBody({
  block,
  language,
  questionId,
  internalLinks,
  placeholder,
}: {
  readonly block: Block;
  readonly language: BlockLanguage;
  /** Whose headers this block compiles against (`S05`). Null on a markdown surface. */
  readonly questionId: string | null;
  readonly internalLinks?: InternalLinkRenderer | undefined;
  /**
   * What a blank block reads as when it is not being typed in. The surface says it, because
   * the one blank block of a surface that opens ready (`P08`) is where the invitation the
   * empty state used to carry now belongs.
   */
  readonly placeholder?: string | undefined;
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
    return <span className="wr-block__placeholder">{placeholder ?? 'Empty block'}</span>;
  }
  if (block.type === 'image') {
    const image = parseBlockImage(block.src, language);
    if (image !== null) {
      return (
        <img
          className="wr-block__figure"
          src={image.url}
          alt={image.alt}
          {...(image.title === null ? {} : { title: image.title })}
          // The width as a style *and* as data: the style is what the researcher sees, and the
          // attribute is what a test can read without measuring a box that a panel's own width
          // could have capped.
          {...(image.width === null ? {} : { style: { width: `${String(image.width)}px` } })}
          data-width={image.width === null ? '' : String(image.width)}
        />
      );
    }
  }
  if (language === 'typst') {
    return (
      <TypstBlockBody
        block={block}
        questionId={questionId}
        {...(internalLinks === undefined ? {} : { internalLinks })}
      />
    );
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
  /** Take a block out of the document and write it (`P07`). */
  readonly remove: (index: number) => void;
  /**
   * Add a block after the block the researcher was last in, else at the end (`S08`).
   *
   * The keyboard's answer to "where does this go". A shortcut is pressed either mid-paragraph,
   * with a block open, or after clicking away, with none — and "the active block" has to
   * survive the blur or every shortcut would append. So the surface remembers the last block
   * that was reached rather than reading the one that is open now, and `null` — nothing has
   * been reached on this surface yet — is what "else at the end" describes.
   */
  readonly insertHere: (src: string) => void;
}


export interface BlockEditorProps {
  /**
   * The language this surface's document is written in (`S04`).
   *
   * The journal's day is markdown and stays markdown; a notebook's page is whatever its row
   * says, which is Typst for one minted since the switch and markdown for one written before
   * it. One editor either way — the *language* changed, not the surface.
   */
  readonly language?: BlockLanguage | undefined;
  /** Whose Typst headers the blocks compile against (`S05`). Null on a markdown surface. */
  readonly questionId?: string | null | undefined;
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
  /**
   * What the surface says when nothing is written yet — the empty state, or the placeholder in
   * the first block when `openWhenEmpty` means there is no empty state to show.
   */
  readonly emptyMessage: string;
  /**
   * Open an empty document with one empty block, already being typed in (`P08`).
   *
   * The journal asks for it and the notebook's page does not, and the difference is what the
   * two surfaces are: you arrive on today's journal *in order to write in it*, so a page that
   * greets you with a sentence about how to begin has put a click between you and the thought;
   * a notebook's page arrives with a template and a shape, and opening a block in the middle of
   * it would be guessing where you meant to work.
   *
   * Costless if nothing is typed: `serializeBlocks` drops a block that is only whitespace, so a
   * day that was merely looked at serializes to the empty string and stays unlogged.
   */
  readonly openWhenEmpty?: boolean | undefined;
  /** The label on the explicit save button; blurring commits either way. */
  readonly saveLabel: string;
  /** The drop attribute the preload reads, if this surface accepts pictures. */
  readonly dropAttribute?: { readonly name: string; readonly value: string } | undefined;
  /** Extra controls in the insert strip — the notebook's `Insert excerpt…` (`S03`). */
  readonly extraControls?: ReactNode;
  /**
   * Ask the owner for a picture, or for a highlight (`S08`).
   *
   * The editor cannot choose either: one is a row in the library and the other is a marked
   * sentence, and both are the page's business. What the editor owns is *where the block goes*,
   * which is why the owner answers by calling `insertHere` rather than by inserting itself.
   */
  readonly onPickImage?: (() => void) | undefined;
  readonly onPickExcerpt?: (() => void) | undefined;
}

export const BlockEditor = forwardRef<BlockEditorHandle, BlockEditorProps>(function BlockEditor(
  {
    surfaceId,
    language = 'markdown',
    questionId = null,
    value,
    onCommit,
    testIdPrefix,
    ariaLabel,
    emptyMessage,
    openWhenEmpty,
    saveLabel,
    dropAttribute,
    extraControls,
    onPickImage,
    onPickExcerpt,
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
  const [rows, setRows] = useState<readonly BlockRow[]>(() => toRows(parseBlocks(value, language)));
  const [editing, setEditing] = useState<Editing | null>(null);
  // The document these rows were parsed from. `value` changing away from it is a write that
  // happened somewhere else — another window, or the main process writing in a picture.
  const baseline = useRef(value);
  // Written during render on purpose: `commit` runs from a blur, which is a task of its own,
  // and it has to see the keystroke that caused the blur rather than the render before it.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  /**
   * Which write is the newest, so an older one's answer cannot undo it.
   *
   * Two writes are in flight together the moment a gesture both blurs an open block and changes
   * the document: clicking a block's Delete blurs the block being typed in, which commits, and
   * then deletes, which commits again (`P07`). Both answer with "what was stored"; if the first
   * answer lands last, the editor re-parses the document that still has the deleted block in
   * it and the block comes back. The rows are only taken from the answer to the latest write.
   */
  const writeTicket = useRef(0);

  useEffect(() => {
    if (value === baseline.current) return;
    const mine = serializeBlocks(rowsRef.current);
    const merged = mergeAppend(baseline.current, mine, value);
    baseline.current = value;
    setRows(toRows(parseBlocks(merged, language)));
    setEditing(null);
  }, [language, value]);

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
    writeTicket.current += 1;
    const ticket = writeTicket.current;
    const stored = await onCommit(markdown);
    if (ticket !== writeTicket.current) return;
    baseline.current = stored;
    setRows(toRows(parseBlocks(stored, language)));
  }, [language, onCommit]);

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
    writeTicket.current += 1;
    const ticket = writeTicket.current;
    const stored = await onCommit(markdown);
    if (ticket !== writeTicket.current) return;
    baseline.current = stored;
    // Only when the store normalized something: re-parsing rebuilds every row, and a rebuilt
    // row is a textarea React has replaced, which takes the caret with it.
    if (stored !== markdown) setRows(toRows(parseBlocks(stored, language)));
  }, [language, onCommit]);

  /**
   * The block the researcher was last in, which outlives the blur (`S08`).
   *
   * `editing` drops to null the moment a block commits, so a shortcut pressed after clicking
   * away — which is most of them — would have no idea where "here" was. This is the answer to
   * "after the active block, else at the end": it is set when a block is opened and never
   * cleared, and `null` means nothing on this surface has been reached yet.
   */
  const lastActive = useRef<number | null>(null);

  const open = useCallback((index: number, offset?: number) => {
    lastActive.current = index;
    setEditing({ index, offset: offset ?? rowsRef.current[index]?.src.length ?? 0 });
  }, []);

  /** The same, at a place: the new block lands after `index` and opens there. */
  const insertAfter = useCallback(
    (index: number | null, src: string) => {
      setRows((current) => {
        const at = index === null ? current.length : Math.min(index + 1, current.length);
        lastActive.current = at;
        setEditing({ index: at, offset: src.length });
        const next = [...current];
        next.splice(at, 0, { key: nextKey(), type: classify(src, language), src });
        return next;
      });
    },
    [language],
  );

  /** Add a block at the end and open it: an inserted block is one you are about to type in. */
  const insert = useCallback((src: string) => insertAfter(null, src), [insertAfter]);

  /** After the block last written in, else at the end — the whole of `S08`'s placement rule. */
  const insertHere = useCallback(
    (src: string) => insertAfter(lastActive.current, src),
    [insertAfter],
  );

  /**
   * Take a block out, and write the document (`P07`).
   *
   * `rowsRef` is written here rather than waited for: `commit` reads it synchronously and this
   * runs from a click, so the next render has not happened yet and the commit would otherwise
   * serialize the list that still has the block in it. Same reason the ref is written during
   * render — a blur and a click are both tasks that land between renders.
   */
  const remove = useCallback(
    (index: number) => {
      const next = rowsRef.current.filter((_, at) => at !== index);
      rowsRef.current = next;
      setRows(next);
      void commit();
    },
    [commit],
  );

  /**
   * A surface with nothing on it opens with one block, ready to type in (`P08`).
   *
   * The whole difficulty is knowing when *not* to. Opening a block puts the caret in it, so a
   * rule of "re-open whenever the document is empty" is a focus trap: click the calendar with
   * an untouched block open and the surface would blur, notice it is empty, and take the focus
   * straight back off the day you were trying to reach. So the seed fires on the two things
   * that are actually arrivals — a surface that has never been seeded (`surfaceId` names the
   * notebook *and* the day, so switching days is a different surface) and a document that has
   * just been emptied down to no blocks at all — and never merely because a block was left
   * blank. A blank block left behind carries the invitation instead, and one click opens it.
   */
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (openWhenEmpty !== true) return;
    if (serializeBlocks(rows) !== '') {
      seededFor.current = surfaceId;
      return;
    }
    if (rows.length > 0 && seededFor.current === surfaceId) return;
    seededFor.current = surfaceId;
    setRows([{ key: nextKey(), type: 'text', src: '' }]);
    setEditing({ index: 0, offset: 0 });
  }, [openWhenEmpty, rows, surfaceId]);

  const handle = useMemo<BlockEditorHandle>(
    () => ({ open, insert, insertAfter, insertHere, save: () => void save(), remove }),
    [open, insert, insertAfter, insertHere, save, remove],
  );
  useImperativeHandle(ref, () => handle, [handle]);

  // --- the two gestures a document you write in needs ----------------------
  // Both are pointer drags rather than HTML5 drag-and-drop, and that is not a preference: the
  // preload's file-drop listener is watching `drop` on these very elements, so a synthetic drag
  // of a block would arrive at the main process looking like a picture landing on the page.
  // Both also follow the queue's discipline — capture on the handle, listeners on the window,
  // `pointercancel` unbinds — so a pointer that leaves the window does not leave a drag running.

  /**
   * Where each row is on screen, so a drag can tell which one it is over (`P07`).
   *
   * Keyed by the row's key and never by its index: the indices are exactly the thing that is
   * changing while the pointer moves.
   */
  const rowBoxes = useRef(new Map<number, HTMLElement>());
  const [dragging, setDragging] = useState<number | null>(null);

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, key: number) => {
      event.preventDefault();
      event.stopPropagation();
      const grip = event.currentTarget;
      grip.setPointerCapture(event.pointerId);
      setDragging(key);

      // The landing place is read off the rendered boxes rather than from a drop target, so the
      // page reorders as the pointer passes each midpoint and what is on screen when the button
      // comes up is exactly what gets written.
      const onMove = (move: PointerEvent): void => {
        const current = rowsRef.current;
        const from = current.findIndex((row) => row.key === key);
        if (from === -1) return;
        let landing = from;
        current.forEach((row, index) => {
          if (row.key === key) return;
          const element = rowBoxes.current.get(row.key);
          if (element === undefined) return;
          const box = element.getBoundingClientRect();
          if (move.clientY < box.top + box.height / 2) landing = Math.min(landing, index);
          else landing = Math.max(landing, index);
        });
        if (landing === from) return;
        const next = moveBlock(current, from, landing);
        rowsRef.current = next;
        setRows(next);
      };

      const onUp = (): void => {
        if (grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        setDragging(null);
        void commit();
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [commit],
  );

  /**
   * Drag a figure's corner to the size it should be (`P11`).
   *
   * The width goes straight into the block's markdown on every move, so what is on screen is
   * the document rather than a preview of it, and the commit at the end is the same commit
   * every other edit makes. Nothing touches the file: the bytes came in over `rrfile://` and a
   * resize is a fact about how the figure is *drawn*.
   */
  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, key: number) => {
      event.preventDefault();
      event.stopPropagation();
      const grip = event.currentTarget;
      const figure = grip.parentElement?.querySelector('img');
      if (!(figure instanceof HTMLImageElement)) return;
      const fromX = event.clientX;
      const fromWidth = figure.getBoundingClientRect().width;
      grip.setPointerCapture(event.pointerId);

      const onMove = (move: PointerEvent): void => {
        const width = Math.max(MIN_FIGURE_WIDTH, Math.round(fromWidth + (move.clientX - fromX)));
        const current = rowsRef.current;
        const at = current.findIndex((row) => row.key === key);
        const row = at === -1 ? undefined : current[at];
        if (row === undefined) return;
        const src = withBlockImageWidth(row.src, width, language);
        if (src === row.src) return;
        const next = current.map((candidate, index) =>
          index === at ? { ...candidate, src, type: classify(src, language) } : candidate,
        );
        rowsRef.current = next;
        setRows(next);
      };

      const onUp = (): void => {
        if (grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        void commit();
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [commit, language],
  );

  // Registered for as long as it is mounted, so a command can act on it by name. The last
  // surface registered is also the one in hand until something else is touched, which is what
  // makes the palette's copy of these commands work with no argument at all.
  useEffect(
    () =>
      registerBlockSurface(surfaceId, {
        ...handle,
        ...(onPickImage === undefined ? {} : { pickImage: onPickImage }),
        ...(onPickExcerpt === undefined ? {} : { pickExcerpt: onPickExcerpt }),
      }),
    [handle, onPickExcerpt, onPickImage, surfaceId],
  );

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
        {rows.map((row, index) => (
          <div
            key={row.key}
            className={
              dragging === row.key ? 'wr-blocks__row wr-blocks__row--held' : 'wr-blocks__row'
            }
            // `…-row-`, `…-grip-`, `…-delete-` and `…-resize-` rather than `…-block-something`:
            // the specs count a surface's blocks with `[data-testid^="<prefix>-block-"]`, and a
            // handle named under that prefix would be counted as a block.
            data-testid={`${testIdPrefix}-row-${String(index)}`}
            ref={(element) => {
              if (element === null) rowBoxes.current.delete(row.key);
              else rowBoxes.current.set(row.key, element);
            }}
          >
            {/*
              The block's two handles, drawn *beside* the block rather than inside it. A click
              into a block reads the element's own `textContent` to work out where the caret
              belongs (`P05`), so a glyph inside the box would shift every offset in the
              paragraph past it — the caret would land a character or two off in every block
              with a handle on it, which is the kind of bug that survives a review.
            */}
            <div className="wr-block__tools">
              <button
                type="button"
                className="wr-block__grip"
                aria-label={`Move block ${String(index + 1)}`}
                title="Drag to move this block"
                data-testid={`${testIdPrefix}-grip-${String(index)}`}
                data-control="block.rearrange"
                onPointerDown={(event) => startDrag(event, row.key)}
              >
                ⠿
              </button>
              <button
                type="button"
                className="wr-block__delete"
                aria-label={`Delete block ${String(index + 1)}`}
                title="Delete this block"
                data-testid={`${testIdPrefix}-delete-${String(index)}`}
                onClick={(event) => {
                  event.stopPropagation();
                  remove(index);
                }}
              >
                ×
              </button>
            </div>
            {editing?.index === index ? (
              <textarea
                className="wr-input wr-blocks__editor"
                aria-label={ariaLabel(index)}
                placeholder={
                  row.type === 'code'
                    ? 'A command, or a snippet'
                    : rows.length === 1 && row.src === ''
                      ? emptyMessage
                      : 'Markdown'
                }
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
                      at === index ? { ...candidate, src, type: classify(src, language) } : candidate,
                    ),
                  );
                }}
                onBlur={() => void commit()}
              />
            ) : (
              <div
                className={`wr-block wr-block--${row.type}`}
                data-testid={`${testIdPrefix}-block-${String(index)}`}
                data-block-type={row.type}
                role="button"
                tabIndex={0}
                title="Click to edit this block"
                onClick={(event) => {
                  touchBlockSurface(surfaceId);
                  lastActive.current = index;
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
                  if (event.key === 'Enter') {
                    lastActive.current = index;
                    setEditing({ index, offset: row.src.length });
                  }
                }}
              >
                <BlockBody
                block={row}
                language={language}
                questionId={questionId}
                internalLinks={internalLinks}
                // A surface that opens ready has no empty state to carry the invitation, so
                // its one blank block carries it instead (`P08`).
                {...(rows.length === 1 && openWhenEmpty === true ? { placeholder: emptyMessage } : {})}
              />
                {/* A figure's own corner (`P11`). Deliberately childless: an empty button
                    contributes nothing to `textContent`, so the caret arithmetic above is
                    untouched by a block having a handle. */}
                {row.type === 'image' && (
                  <button
                    type="button"
                    className="wr-block__resize"
                    aria-label={`Resize the figure in block ${String(index + 1)}`}
                    title="Drag to resize this figure"
                    data-testid={`${testIdPrefix}-resize-${String(index)}`}
                    data-control="block.resize"
                    onPointerDown={(event) => startResize(event, row.key)}
                    onClick={(event) => event.stopPropagation()}
                  />
                )}
              </div>
            )}
          </div>
        ))}
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
        {/* `+ image` picks from what the library already holds (`S06`, `S08`). New bytes still
            arrive by being dropped — nothing in this world can ask the operating system for a
            file — but a picture that has been dropped once is a row, and putting it in a second
            place should not mean finding it on disk again. The hint below still says how a new
            one gets in. */}
        {onPickImage !== undefined && (
          <button
            type="button"
            className="wr-button"
            data-testid={`${testIdPrefix}-add-image`}
            data-control="block.picture"
            onClick={() => onPickImage()}
          >
            + image
          </button>
        )}
        {extraControls}
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
