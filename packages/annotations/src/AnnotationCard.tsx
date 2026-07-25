import { useState } from 'react';
import {
  highlightColorVariable,
  type AnnotationWithAnchor,
  type HighlightColor,
  type ResolvedLocation,
} from '@wr/shared-types';
import { Badge, classNames } from '@wr/shared-ui';
import { describeAnchorHealth } from './anchor-health.js';
import { HighlightPopover } from './HighlightPopover.js';

export interface AnnotationCardProps {
  readonly annotation: AnnotationWithAnchor;
  /** Result of resolving this annotation's anchor against the rendered document. */
  readonly resolved: ResolvedLocation | null;
  readonly selected: boolean;
  readonly noteCount: number;
  readonly onSelect: () => void;
  readonly onAddNote: () => void;
  readonly onChangeColor: (color: HighlightColor) => void;
  readonly onChangeComment: (comment: string | null) => void;
  readonly onDelete: () => void;
  readonly onFindReferences: () => void;
}

function pageLabel(annotation: AnnotationWithAnchor): string | null {
  return annotation.anchor.kind === 'pdf'
    ? `p. ${String(annotation.anchor.pageIndex + 1)}`
    : null;
}

export function AnnotationCard({
  annotation,
  resolved,
  selected,
  noteCount,
  onSelect,
  onAddNote,
  onChangeColor,
  onChangeComment,
  onDelete,
  onFindReferences,
}: AnnotationCardProps): JSX.Element {
  const health = describeAnchorHealth(annotation.anchor, resolved);
  const page = pageLabel(annotation);
  const [editing, setEditing] = useState(false);

  return (
    <article
      className={classNames('wr-annotation', selected && 'wr-annotation--selected')}
      data-testid={`annotation-${annotation.id}`}
      data-anchor-state={health.state}
      aria-current={selected ? 'true' : undefined}
    >
      <button type="button" className="wr-annotation__body" onClick={onSelect}>
        <span
          className="wr-annotation__swatch"
          data-testid={`annotation-swatch-${annotation.id}`}
          data-highlight-color={annotation.color}
          style={{ background: highlightColorVariable(annotation.color) }}
          aria-hidden="true"
        />
        <blockquote className="wr-annotation__quote">{annotation.selectedText}</blockquote>
        {annotation.comment !== null && annotation.comment.length > 0 && (
          <p className="wr-annotation__comment">{annotation.comment}</p>
        )}
        <footer className="wr-annotation__meta">
          {page !== null && <span>{page}</span>}
          {health.state !== 'ok' && (
            <Badge tone={health.state === 'broken' ? 'warning' : 'neutral'} title={health.detail}>
              {health.label}
            </Badge>
          )}
          {noteCount > 0 && (
            <Badge tone="accent" title={`${String(noteCount)} linked note(s)`}>
              {noteCount === 1 ? '1 note' : `${String(noteCount)} notes`}
            </Badge>
          )}
        </footer>
      </button>

      <div className="wr-annotation__actions">
        <button
          type="button"
          className="wr-button wr-button--icon"
          onClick={onAddNote}
          data-testid={`annotation-add-note-${annotation.id}`}
          title="Attach a note to this highlight"
        >
          Note
        </button>
        <button
          type="button"
          className="wr-button wr-button--icon"
          onClick={onFindReferences}
          title="Find everything linked to this highlight (Shift+F12)"
        >
          Refs
        </button>
        <button
          type="button"
          className="wr-button wr-button--icon"
          data-testid={`annotation-edit-${annotation.id}`}
          aria-expanded={editing}
          onClick={() => {
            setEditing((open) => !open);
          }}
          title="Colour, comment on, or delete this highlight"
        >
          Edit
        </button>
      </div>

      {editing && (
        <HighlightPopover
          annotation={annotation}
          onChangeColor={onChangeColor}
          onChangeComment={(comment) => {
            onChangeComment(comment);
            setEditing(false);
          }}
          onDelete={onDelete}
          onClose={() => {
            setEditing(false);
          }}
        />
      )}
    </article>
  );
}
