import { useMemo, type MouseEvent } from 'react';
import type { AnnotationWithAnchor, HighlightColor, ResolvedLocation } from '@wr/shared-types';
import { EmptyState } from '@wr/shared-ui';
import { AnnotationCard } from './AnnotationCard.js';

export interface AnnotationListProps {
  readonly annotations: readonly AnnotationWithAnchor[];
  /**
   * Anchor resolution per annotation id, from the reader that is rendering the document.
   *
   * Absent from the map means the reader has not reported on that annotation — not that the
   * anchor failed. Only a reader that publishes resolutions can say "broken".
   */
  readonly resolutions: ReadonlyMap<string, ResolvedLocation | null>;
  readonly noteCounts: ReadonlyMap<string, number>;
  readonly selectedAnnotationId: string | null;
  readonly onSelect: (annotationId: string) => void;
  readonly onAddNote: (annotationId: string) => void;
  readonly onChangeColor: (annotationId: string, color: HighlightColor) => void;
  readonly onChangeComment: (annotationId: string, comment: string | null) => void;
  readonly onDelete: (annotationId: string) => void;
  readonly onFindReferences: (annotationId: string) => void;
  /** A right-click on one card, with the highlight it happened on (`R01`). */
  readonly onContextMenu?: (annotationId: string, event: MouseEvent) => void;
}

/**
 * Annotations for the active document, in reading order.
 *
 * Sorted by position rather than creation time: the list is read alongside the document,
 * and an ordering that does not match the page the user is looking at is one they have to
 * search through every time.
 */
export function AnnotationList({
  annotations,
  resolutions,
  noteCounts,
  selectedAnnotationId,
  onSelect,
  onAddNote,
  onChangeColor,
  onChangeComment,
  onDelete,
  onFindReferences,
  onContextMenu,
}: AnnotationListProps): JSX.Element {
  const ordered = useMemo(() => {
    return [...annotations].sort((left, right) => {
      const leftPage = left.anchor.kind === 'pdf' ? left.anchor.pageIndex : 0;
      const rightPage = right.anchor.kind === 'pdf' ? right.anchor.pageIndex : 0;
      if (leftPage !== rightPage) return leftPage - rightPage;
      const leftStart = left.anchor.kind === 'pdf' ? left.anchor.position.start : 0;
      const rightStart = right.anchor.kind === 'pdf' ? right.anchor.position.start : 0;
      if (leftStart !== rightStart) return leftStart - rightStart;
      return left.createdAt.localeCompare(right.createdAt);
    });
  }, [annotations]);

  if (ordered.length === 0) {
    return (
      <EmptyState
        testId="annotations-empty"
        message="No highlights in this document."
        hint="Select text in the reader to create one."
      />
    );
  }

  return (
    <div className="wr-annotations" data-testid="annotation-list">
      {ordered.map((annotation) => (
        <AnnotationCard
          key={annotation.id}
          annotation={annotation}
          resolved={resolutions.get(annotation.id)}
          noteCount={noteCounts.get(annotation.id) ?? 0}
          selected={annotation.id === selectedAnnotationId}
          onSelect={() => onSelect(annotation.id)}
          onAddNote={() => onAddNote(annotation.id)}
          onChangeColor={(color) => onChangeColor(annotation.id, color)}
          onChangeComment={(comment) => onChangeComment(annotation.id, comment)}
          onDelete={() => onDelete(annotation.id)}
          onFindReferences={() => onFindReferences(annotation.id)}
          {...(onContextMenu === undefined
            ? {}
            : { onContextMenu: (event: MouseEvent) => onContextMenu(annotation.id, event) })}
        />
      ))}
    </div>
  );
}
