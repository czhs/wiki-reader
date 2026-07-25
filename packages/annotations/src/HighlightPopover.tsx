import { useEffect, useRef, useState } from 'react';
import {
  HIGHLIGHT_COLORS,
  HIGHLIGHT_COLOR_LABELS,
  highlightColorVariable,
  type AnnotationWithAnchor,
  type HighlightColor,
} from '@wr/shared-types';

export interface HighlightPopoverProps {
  readonly annotation: AnnotationWithAnchor;
  readonly onChangeColor: (color: HighlightColor) => void;
  /** Empty text clears the comment, which is why `null` is in the signature. */
  readonly onChangeComment: (comment: string | null) => void;
  readonly onDelete: () => void;
  readonly onClose: () => void;
}

/**
 * Everything you can do to a highlight once it exists: recolour it, say why you kept it, or
 * throw it away.
 *
 * The three live together because they are one thought — reviewing a highlight — and
 * splitting them across the card's action row would mean deleting is a click away from
 * recolouring. The swatches paint themselves from the same CSS variables the reader paints
 * the document with, so what you pick here is what you see there under any theme.
 */
export function HighlightPopover({
  annotation,
  onChangeColor,
  onChangeComment,
  onDelete,
  onClose,
}: HighlightPopoverProps): JSX.Element {
  const [comment, setComment] = useState(annotation.comment ?? '');
  const firstSwatch = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstSwatch.current?.focus();
  }, []);

  return (
    <div
      className="wr-highlight-popover"
      data-testid="highlight-popover"
      role="dialog"
      aria-label="Edit highlight"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div className="wr-highlight-popover__colors" role="group" aria-label="Highlight colour">
        {HIGHLIGHT_COLORS.map((color, index) => (
          <button
            key={color}
            ref={index === 0 ? firstSwatch : undefined}
            type="button"
            className="wr-highlight-popover__swatch"
            data-testid={`highlight-color-${color}`}
            data-highlight-color={color}
            aria-pressed={annotation.color === color}
            title={HIGHLIGHT_COLOR_LABELS[color]}
            aria-label={HIGHLIGHT_COLOR_LABELS[color]}
            style={{ background: highlightColorVariable(color) }}
            onClick={() => {
              onChangeColor(color);
            }}
          />
        ))}
      </div>

      <label className="wr-highlight-popover__field">
        <span className="wr-highlight-popover__label">Comment</span>
        <textarea
          className="wr-highlight-popover__comment"
          data-testid="highlight-comment"
          value={comment}
          rows={3}
          placeholder="Why this matters"
          onChange={(event) => {
            setComment(event.target.value);
          }}
        />
      </label>

      <div className="wr-highlight-popover__actions">
        <button
          type="button"
          className="wr-button wr-button--primary"
          data-testid="highlight-comment-save"
          onClick={() => {
            const trimmed = comment.trim();
            onChangeComment(trimmed.length === 0 ? null : trimmed);
          }}
        >
          Save
        </button>
        <button
          type="button"
          className="wr-button wr-button--danger"
          data-testid="highlight-delete"
          onClick={onDelete}
        >
          Delete
        </button>
        <button
          type="button"
          className="wr-button"
          data-testid="highlight-popover-close"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </div>
  );
}
