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
export {
  ANNOTATION_COLORS,
  describeAnchorHealth,
  type AnchorHealth,
  type AnnotationColor,
} from './anchor-health.js';
