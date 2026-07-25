/**
 * @wr/annotations — the annotation list and the vocabulary around anchor health.
 *
 * The panel's job is not decoration: it is the only place a *broken* anchor becomes
 * visible. A highlight whose text has moved is repainted silently by the reader; one whose
 * text is gone cannot be painted at all, and if the list did not say so the annotation
 * would simply appear to have been deleted.
 */
export { AnnotationList, type AnnotationListProps } from './AnnotationList.js';
export { AnnotationCard, type AnnotationCardProps } from './AnnotationCard.js';
export { HighlightPopover, type HighlightPopoverProps } from './HighlightPopover.js';
export { describeAnchorHealth, type AnchorHealth } from './anchor-health.js';
