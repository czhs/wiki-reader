/**
 * A question's desk board (criteria N06, N07).
 *
 * Papers and highlights laid out by hand, the way they would be on a desk. The board is not a
 * new relationship: every card is a `question-references-…` edge, so putting something on the
 * board and relating it to the question are the same act, and taking a card off deletes the
 * edge rather than hiding it.
 *
 * Two rules the board keeps, and both are about *not* recording things:
 *
 * - **A position is written only when a card is dragged.** Cards nobody has moved are laid
 *   out by the code below and stored nowhere, so the default can change later without
 *   silently moving cards somebody thinks they placed. `data-placed` says which is which.
 * - **A dropped file is not copied.** The drop is handled in the preload, which is the only
 *   place that can turn a `File` into a path; the file stays where it is on disk and the
 *   board records a reference. Nothing in this module ever sees a path — it learns that the
 *   board changed and asks for the page again.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { LinkIdSchema, QuestionIdSchema, type BoardCard } from '@wr/shared-types';
import { call, describeError } from './ipc.js';
import { useWorkspace } from './workspace.js';

/** The attribute the preload's drop listener looks for. Kept here beside the element. */
export const DROP_QUESTION_ATTRIBUTE = 'data-wr-drop-question';

/** How far a pointer travels before a press counts as a drag rather than a click. */
const DRAG_THRESHOLD = 3;

const CARD_WIDTH = 184;
const CARD_HEIGHT = 96;
const GAP = 16;
const COLUMNS = 3;

/**
 * Where a card sits before anybody has moved it.
 *
 * Deliberately a pure function of the index rather than stored state: an arrangement nobody
 * chose is a property of the current layout, not a fact about the researcher's board.
 */
export function defaultSpot(index: number): { x: number; y: number } {
  return {
    x: GAP + (index % COLUMNS) * (CARD_WIDTH + GAP),
    y: GAP + Math.floor(index / COLUMNS) * (CARD_HEIGHT + GAP),
  };
}

interface LibraryChoice {
  readonly id: string;
  readonly title: string;
}

export function DeskBoard({
  questionId,
  cards,
  onChanged,
}: {
  readonly questionId: string;
  readonly cards: readonly BoardCard[];
  /** The board changed on the main process's side; take the page again. */
  readonly onChanged: () => void | Promise<void>;
}): JSX.Element {
  const { store, workbench } = useWorkspace();
  const board = useRef<HTMLDivElement | null>(null);
  const [dragged, setDragged] = useState<{ linkId: string; x: number; y: number } | null>(null);
  const [choices, setChoices] = useState<readonly LibraryChoice[]>([]);
  const [chosen, setChosen] = useState('');
  /**
   * Where the drag currently stands, outside React state.
   *
   * A drag is a stream of pointer events and the drop has to commit exactly what the last
   * move left on screen — the same reason the queue keeps its order in a ref.
   */
  const live = useRef<{ linkId: string; x: number; y: number } | null>(null);

  const report = useCallback(
    (failure: unknown) => {
      store.setStatus(describeError(failure).message, 'error');
    },
    [store],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await call('library:listDocuments', { limit: 200, offset: 0 });
        if (cancelled) return;
        setChoices(result.items.map((item) => ({ id: item.document.id, title: item.document.title })));
      } catch (failure) {
        report(failure);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [report]);

  const spotOf = useCallback(
    (card: BoardCard, index: number): { x: number; y: number } => {
      if (dragged !== null && dragged.linkId === card.linkId) return { x: dragged.x, y: dragged.y };
      return card.position ?? defaultSpot(index);
    },
    [dragged],
  );

  const commit = useCallback(async () => {
    const held = live.current;
    live.current = null;
    setDragged(null);
    if (held === null) return;
    const question = QuestionIdSchema.safeParse(questionId);
    const link = LinkIdSchema.safeParse(held.linkId);
    if (!question.success || !link.success) return;
    try {
      await call('question:placeCard', {
        questionId: question.data,
        linkId: link.data,
        x: held.x,
        y: held.y,
      });
    } catch (failure) {
      report(failure);
    } finally {
      await onChanged();
    }
  }, [onChanged, questionId, report]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>, card: BoardCard, index: number) => {
      if (event.button !== 0) return;
      const surface = board.current;
      if (surface === null) return;

      const box = surface.getBoundingClientRect();
      const from = spotOf(card, index);
      const grabX = event.clientX - box.left + surface.scrollLeft - from.x;
      const grabY = event.clientY - box.top + surface.scrollTop - from.y;
      const target = event.currentTarget;
      const origin = { x: event.clientX, y: event.clientY };
      /**
       * A press is not a drag until the pointer has actually moved.
       *
       * Nothing is captured and nothing is prevented before then, because both break the
       * click: a captured pointer retargets the compatibility mouse events at the card, so
       * the button inside it never hears the click and the card can never be opened. That is
       * exactly the bug this threshold exists to prevent, and it is why a drag begins on
       * movement rather than on contact.
       */
      let moved = false;

      const at = (moveEvent: PointerEvent): { x: number; y: number } => ({
        // Board coordinates, so the card lands where the pointer is even when the board is
        // scrolled. Clamped at the top-left only: a board grows to the right and downwards,
        // and clamping the far edge would make a card jump when the panel is resized.
        x: Math.max(0, Math.round(moveEvent.clientX - box.left + surface.scrollLeft - grabX)),
        y: Math.max(0, Math.round(moveEvent.clientY - box.top + surface.scrollTop - grabY)),
      });

      const onMove = (moveEvent: PointerEvent): void => {
        if (!moved) {
          const distance = Math.hypot(moveEvent.clientX - origin.x, moveEvent.clientY - origin.y);
          if (distance < DRAG_THRESHOLD) return;
          moved = true;
          // Captured only now, so the drag survives the pointer leaving the card — and so a
          // drag that ends over the title does not also open it.
          target.setPointerCapture(moveEvent.pointerId);
        }
        const next = { linkId: card.linkId, ...at(moveEvent) };
        live.current = next;
        setDragged(next);
      };

      const onUp = (upEvent: PointerEvent): void => {
        if (target.hasPointerCapture(upEvent.pointerId)) {
          target.releasePointerCapture(upEvent.pointerId);
        }
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        // A press that never moved is not a placement: `live` is null and `commit` does
        // nothing, so clicking a card cannot pin it where it already was.
        void commit();
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      // A cancelled pointer (the OS taking over, a gesture) must not leave the board holding
      // a drag nobody can finish.
      window.addEventListener('pointercancel', onUp);
    },
    [commit, spotOf],
  );

  const open = useCallback(
    (card: BoardCard) => {
      if (card.broken) return;
      void workbench.navigate(
        {
          entityId: card.entityId,
          entityType: card.entityType,
          ...(card.documentId === null ? {} : { documentId: card.documentId }),
          ...(card.location === null ? {} : { location: card.location }),
        },
        'current',
      );
    },
    [workbench],
  );

  const add = useCallback(async () => {
    const question = QuestionIdSchema.safeParse(questionId);
    if (!question.success || chosen === '') return;
    try {
      await call('question:attach', {
        questionId: question.data,
        targetType: 'document',
        targetId: chosen,
      });
      setChosen('');
    } catch (failure) {
      report(failure);
    } finally {
      await onChanged();
    }
  }, [chosen, onChanged, questionId, report]);

  const remove = useCallback(
    async (card: BoardCard) => {
      const link = LinkIdSchema.safeParse(card.linkId);
      if (!link.success) return;
      try {
        // The edge *is* the card, so this is the only deletion there is — and the position
        // goes with it, rather than waiting to reappear under some later card.
        await call('link:delete', { linkId: link.data });
      } catch (failure) {
        report(failure);
      } finally {
        await onChanged();
      }
    },
    [onChanged, report],
  );

  const height =
    GAP +
    cards.reduce(
      (tallest, card, index) => Math.max(tallest, spotOf(card, index).y + CARD_HEIGHT),
      CARD_HEIGHT * 2,
    );

  return (
    <section className="wr-notebook__desk">
      <div className="wr-notebook__prose-head">
        <h3 className="wr-list__section">
          Desk
          <span className="wr-list__section-count">{cards.length}</span>
        </h3>
        <span className="wr-notebook__outline">
          Drag a card to place it. Drop a file here to add one.
        </span>
      </div>

      <div
        className="wr-board"
        data-testid="notebook-board"
        // The preload's drop listener finds the board by this attribute — it shares the DOM
        // but not this world, so the question id has to be written where it can read it.
        {...{ [DROP_QUESTION_ATTRIBUTE]: questionId }}
        ref={board}
        style={{ height: `${String(height)}px` }}
      >
        {cards.length === 0 && (
          <p className="wr-board__empty" data-testid="notebook-board-empty">
            Nothing on the desk yet.
          </p>
        )}
        {cards.map((card, index) => {
          const spot = spotOf(card, index);
          return (
            <article
              key={card.linkId}
              className={card.broken ? 'wr-board__card wr-board__card--broken' : 'wr-board__card'}
              data-testid={`board-card-${card.linkId}`}
              data-entity-id={card.entityId}
              // Whether this card was placed *by hand* — the board's whole rule, so it is
              // said in the DOM rather than inferred from where the card happens to be.
              data-placed={card.position === null ? 'false' : 'true'}
              data-x={String(Math.round(spot.x))}
              data-y={String(Math.round(spot.y))}
              style={{ left: `${String(spot.x)}px`, top: `${String(spot.y)}px` }}
              onPointerDown={(event) => onPointerDown(event, card, index)}
            >
              <button
                type="button"
                className="wr-board__title"
                title={card.broken ? 'This card no longer resolves' : 'Open it'}
                data-testid={`board-open-${card.linkId}`}
                disabled={card.broken}
                onClick={() => open(card)}
              >
                {card.broken ? `${card.title} (missing)` : card.title}
              </button>
              {card.label !== null && <span className="wr-board__note">{card.label}</span>}
              <button
                type="button"
                className="wr-board__remove"
                aria-label={`Take ${card.title} off the board`}
                data-testid={`board-remove-${card.linkId}`}
                onClick={() => void remove(card)}
              >
                ×
              </button>
            </article>
          );
        })}
      </div>

      <div className="wr-board__add">
        <select
          className="wr-input"
          aria-label="Something in the library to put on the board"
          data-testid="board-pick"
          value={chosen}
          onChange={(event) => setChosen(event.target.value)}
        >
          <option value="">Pick from the library…</option>
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.title}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="wr-button"
          data-testid="board-add"
          data-control="notebook.desk"
          disabled={chosen === ''}
          onClick={() => void add()}
        >
          Put on the board
        </button>
      </div>
    </section>
  );
}
