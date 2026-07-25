import { z } from 'zod';
import { AnnotationIdSchema, DocumentIdSchema, NoteIdSchema } from './ids.js';

/**
 * Source-independent location and anchoring types.
 *
 * Nothing outside @wr/pdf-reader and @wr/html-reader may depend on PDF.js viewport
 * coordinates or DOM ranges. Everything crossing a package boundary uses these types.
 */

/** A rectangle in page-relative coordinates: 0..1 on both axes, origin top-left. */
export const NormalizedRectSchema = z.object({
  x1: z.number().min(0).max(1),
  y1: z.number().min(0).max(1),
  x2: z.number().min(0).max(1),
  y2: z.number().min(0).max(1),
});
export type NormalizedRect = z.infer<typeof NormalizedRectSchema>;

// ---------------------------------------------------------------------------
// W3C Web Annotation selectors
// ---------------------------------------------------------------------------

/**
 * TextQuoteSelector. `exact` is the selected text; `prefix`/`suffix` are the
 * surrounding context used to disambiguate and to survive small edits.
 */
export const TextQuoteSelectorSchema = z.object({
  exact: z.string().min(1),
  prefix: z.string(),
  suffix: z.string(),
});
export type TextQuoteSelector = z.infer<typeof TextQuoteSelectorSchema>;

/** TextPositionSelector: character offsets into the normalized text of the container. */
export const TextPositionSelectorSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});
export type TextPositionSelector = z.infer<typeof TextPositionSelectorSchema>;

// ---------------------------------------------------------------------------
// Document locations
// ---------------------------------------------------------------------------

export const PdfLocationSchema = z.object({
  kind: z.literal('pdf'),
  pageIndex: z.number().int().nonnegative(),
  /** Optional highlight rectangles to flash when revealing. */
  rects: z.array(NormalizedRectSchema).optional(),
  /** Vertical position within the page, 0 = top. Used to restore scroll. */
  pageOffsetRatio: z.number().min(0).max(1).optional(),
  /** Character range within the page's normalized text. */
  textRange: TextPositionSelectorSchema.optional(),
});
export type PdfLocation = z.infer<typeof PdfLocationSchema>;

export const HtmlLocationSchema = z.object({
  kind: z.literal('html'),
  /** Which rendering the offsets refer to. */
  readerMode: z.enum(['readability', 'original']),
  /** Slash-delimited heading path, e.g. "Results/Ablations". */
  sectionPath: z.string().optional(),
  textRange: TextPositionSelectorSchema.optional(),
  quote: TextQuoteSelectorSchema.optional(),
});
export type HtmlLocation = z.infer<typeof HtmlLocationSchema>;

/**
 * Where inside a markdown document something is.
 *
 * `headingPath` is the slash-joined slug path of the enclosing headings ("results/ablations"),
 * matching the slugs Foam and Obsidian generate, so a `[[page#Section]]` target and a reading
 * position name the same thing.
 */
export const MarkdownLocationSchema = z.object({
  kind: z.literal('markdown'),
  headingPath: z.string().optional(),
  /** Character range within the document's normalized text. */
  textRange: TextPositionSelectorSchema.optional(),
  quote: TextQuoteSelectorSchema.optional(),
  /** Vertical position within the rendered document, 0 = top. Restores scroll. */
  offsetRatio: z.number().min(0).max(1).optional(),
});
export type MarkdownLocation = z.infer<typeof MarkdownLocationSchema>;

export const NoteLocationSchema = z.object({
  kind: z.literal('note'),
  /** Index of the top-level ProseMirror block. */
  blockIndex: z.number().int().nonnegative().optional(),
  /** ProseMirror document position. */
  pmPos: z.number().int().nonnegative().optional(),
});
export type NoteLocation = z.infer<typeof NoteLocationSchema>;

export const DocumentLocationSchema = z.discriminatedUnion('kind', [
  PdfLocationSchema,
  HtmlLocationSchema,
  MarkdownLocationSchema,
  NoteLocationSchema,
]);
export type DocumentLocation = z.infer<typeof DocumentLocationSchema>;

// ---------------------------------------------------------------------------
// Annotation anchors
// ---------------------------------------------------------------------------

/**
 * PDF anchor. Persists text-based evidence alongside geometry so a highlight can be
 * relocated when the file is re-extracted or replaced by a revision. Viewport pixel
 * coordinates are never persisted.
 */
export const PdfAnchorSchema = z.object({
  kind: z.literal('pdf'),
  version: z.literal(1),
  pageIndex: z.number().int().nonnegative(),
  rects: z.array(NormalizedRectSchema).min(1),
  quote: TextQuoteSelectorSchema,
  /** Offsets into the page's normalized text. */
  position: TextPositionSelectorSchema,
  /** Hash of the normalized text of the anchored page. */
  pageTextHash: z.string().min(1),
  /** Content hash of the document revision this anchor was created against. */
  contentHash: z.string().min(1),
});
export type PdfAnchor = z.infer<typeof PdfAnchorSchema>;

/** Optional last-resort DOM fallback. Never the sole anchoring strategy. */
export const DomRangeFallbackSchema = z.object({
  startContainerPath: z.string(),
  startOffset: z.number().int().nonnegative(),
  endContainerPath: z.string(),
  endOffset: z.number().int().nonnegative(),
});
export type DomRangeFallback = z.infer<typeof DomRangeFallbackSchema>;

export const HtmlAnchorSchema = z.object({
  kind: z.literal('html'),
  version: z.literal(1),
  quote: TextQuoteSelectorSchema,
  position: TextPositionSelectorSchema,
  /** Content hash of the archived snapshot. */
  snapshotHash: z.string().min(1),
  /** Which rendering produced the offsets. */
  readerMode: z.enum(['readability', 'original']),
  /** Normalization algorithm version; bump when normalizeText changes. */
  normalizationVersion: z.number().int().positive(),
  sectionPath: z.string().optional(),
  domFallback: DomRangeFallbackSchema.optional(),
});
export type HtmlAnchor = z.infer<typeof HtmlAnchorSchema>;

/**
 * Markdown anchor.
 *
 * Markdown is source text the user can edit outside the app, so geometry would be worthless
 * here: the evidence is the quote plus its offsets into the *normalized* document text, and
 * the hash of that text. A file edited elsewhere fails the hash comparison and the highlight
 * is re-found by quote instead of silently landing in the wrong paragraph.
 */
export const MarkdownAnchorSchema = z.object({
  kind: z.literal('markdown'),
  version: z.literal(1),
  quote: TextQuoteSelectorSchema,
  position: TextPositionSelectorSchema,
  /** Hash of the normalized text the offsets refer to. */
  documentTextHash: z.string().min(1),
  /** Content hash of the markdown file the anchor was created against. */
  sourceHash: z.string().min(1),
  normalizationVersion: z.number().int().positive(),
  headingPath: z.string().optional(),
});
export type MarkdownAnchor = z.infer<typeof MarkdownAnchorSchema>;

export const AnnotationAnchorSchema = z.discriminatedUnion('kind', [
  PdfAnchorSchema,
  HtmlAnchorSchema,
  MarkdownAnchorSchema,
]);
export type AnnotationAnchor = z.infer<typeof AnnotationAnchorSchema>;

/** How an anchor was matched when resolved. Surfaced in the UI for degraded matches. */
export const AnchorMatchStrategySchema = z.enum([
  /** Position offsets matched and the quote at that position is identical. */
  'exact-position',
  /** Quote found at a different offset; anchor was relocated. */
  'quote-relocated',
  /** Quote found using prefix/suffix context after fuzzy matching. */
  'context-fuzzy',
  /** Only the DOM fallback matched. */
  'dom-fallback',
]);
export type AnchorMatchStrategy = z.infer<typeof AnchorMatchStrategySchema>;

export const ResolvedLocationSchema = z.object({
  location: DocumentLocationSchema,
  strategy: AnchorMatchStrategySchema,
  /** 0..1. Below 1 means the anchor moved or matched fuzzily. */
  confidence: z.number().min(0).max(1),
});
export type ResolvedLocation = z.infer<typeof ResolvedLocationSchema>;

// ---------------------------------------------------------------------------
// Reader selection (renderer -> anchor creation)
// ---------------------------------------------------------------------------

export const PdfReaderSelectionSchema = z.object({
  kind: z.literal('pdf'),
  pageIndex: z.number().int().nonnegative(),
  rects: z.array(NormalizedRectSchema).min(1),
  text: z.string().min(1),
  /** Normalized text of the whole page, used to compute context and hash. */
  pageText: z.string(),
  /** Offsets of `text` within `pageText`. */
  position: TextPositionSelectorSchema,
});
export type PdfReaderSelection = z.infer<typeof PdfReaderSelectionSchema>;

export const HtmlReaderSelectionSchema = z.object({
  kind: z.literal('html'),
  readerMode: z.enum(['readability', 'original']),
  text: z.string().min(1),
  containerText: z.string(),
  position: TextPositionSelectorSchema,
  sectionPath: z.string().optional(),
  domFallback: DomRangeFallbackSchema.optional(),
});
export type HtmlReaderSelection = z.infer<typeof HtmlReaderSelectionSchema>;

export const MarkdownReaderSelectionSchema = z.object({
  kind: z.literal('markdown'),
  text: z.string().min(1),
  /** The document's normalized text, which `position` indexes into. */
  documentText: z.string(),
  position: TextPositionSelectorSchema,
  headingPath: z.string().optional(),
});
export type MarkdownReaderSelection = z.infer<typeof MarkdownReaderSelectionSchema>;

export const ReaderSelectionSchema = z.discriminatedUnion('kind', [
  PdfReaderSelectionSchema,
  HtmlReaderSelectionSchema,
  MarkdownReaderSelectionSchema,
]);
export type ReaderSelection = z.infer<typeof ReaderSelectionSchema>;

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export const ExtractedChunkSchema = z.object({
  /** Ordinal within the document, 0-based, stable across re-extraction. */
  index: z.number().int().nonnegative(),
  kind: z.enum(['pdf-page', 'html-section', 'markdown-section', 'note-block']),
  text: z.string(),
  pageIndex: z.number().int().nonnegative().optional(),
  sectionPath: z.string().optional(),
  /** Offsets into the document's full normalized text. */
  charStart: z.number().int().nonnegative(),
  charEnd: z.number().int().nonnegative(),
});
export type ExtractedChunk = z.infer<typeof ExtractedChunkSchema>;

export const ExtractedDocumentSchema = z.object({
  /** Full normalized text, the concatenation the chunk offsets refer to. */
  text: z.string(),
  chunks: z.array(ExtractedChunkSchema),
  /** Hash of `text`; changes when the source content changes. */
  textHash: z.string(),
  normalizationVersion: z.number().int().positive(),
  pageCount: z.number().int().nonnegative().optional(),
  outline: z
    .array(
      z.object({
        title: z.string(),
        level: z.number().int().positive(),
        location: DocumentLocationSchema,
      }),
    )
    .optional(),
});
export type ExtractedDocument = z.infer<typeof ExtractedDocumentSchema>;

export const SearchContextSchema = z.object({
  before: z.string(),
  match: z.string(),
  after: z.string(),
  sectionPath: z.string().optional(),
  pageIndex: z.number().int().nonnegative().optional(),
});
export type SearchContext = z.infer<typeof SearchContextSchema>;

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export const LinkableEntityTypeSchema = z.enum([
  'document',
  'annotation',
  'note',
  'collection',
  'chunk',
  'heading',
  'figure',
  'citation',
  'excerpt',
]);
export type LinkableEntityType = z.infer<typeof LinkableEntityTypeSchema>;

export const NavigationLocationSchema = z.object({
  entityId: z.string().min(1),
  entityType: LinkableEntityTypeSchema,
  documentId: DocumentIdSchema.optional(),
  location: DocumentLocationSchema.optional(),
  panelId: z.string().optional(),
  selection: ReaderSelectionSchema.optional(),
  timestamp: z.number().int().nonnegative(),
});
export type NavigationLocation = z.infer<typeof NavigationLocationSchema>;

/** Parsed form of an internal `scheme://id` link. */
export const InternalLinkSchema = z.discriminatedUnion('scheme', [
  z.object({
    scheme: z.literal('document'),
    documentId: DocumentIdSchema,
    location: DocumentLocationSchema.optional(),
  }),
  z.object({
    scheme: z.literal('annotation'),
    annotationId: AnnotationIdSchema,
  }),
  z.object({
    scheme: z.literal('note'),
    noteId: NoteIdSchema,
    location: NoteLocationSchema.optional(),
  }),
]);
export type InternalLink = z.infer<typeof InternalLinkSchema>;
