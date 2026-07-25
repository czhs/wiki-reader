import type {
  AnnotationAnchor,
  DocumentLocation,
  ExtractedDocument,
  ReaderSelection,
  ResolvedLocation,
  SearchContext,
} from '@wr/shared-types';

/**
 * The source-independent reader contract.
 *
 * Everything above this interface — commands, navigation, search, annotations, notes —
 * speaks only in `DocumentLocation`, `AnnotationAnchor`, and `ReaderSelection`. Nothing
 * above it may reference a PDF.js viewport, a DOM Range, or a CSS selector.
 *
 * Adding EPUB support later means implementing this interface, adding an anchor variant,
 * and nothing else.
 *
 * `TRenderHandle` is whatever the concrete reader hands back from `render` (a React element,
 * a controller object). It is deliberately opaque to callers.
 */
export interface DocumentAdapter<TRenderProps = unknown, TRenderHandle = unknown> {
  /** Which anchor and location variants this adapter produces. */
  readonly kind: 'pdf' | 'html' | 'note';

  /** Produce the presentation for this document. */
  render(props: TRenderProps): TRenderHandle;

  /**
   * Extract the full normalized text and structural chunks. Runs in the main process or a
   * worker, never in the renderer.
   */
  extractText(source: ExtractionSource): Promise<ExtractedDocument>;

  /** Build a durable anchor from a live reader selection. */
  createAnchor(selection: ReaderSelection, context: AnchorContext): AnnotationAnchor;

  /**
   * Locate a stored anchor in the current rendering. Returns `null` when the anchor cannot
   * be resolved with acceptable confidence — a broken anchor, which the UI must surface.
   */
  resolveAnchor(anchor: AnnotationAnchor, context: AnchorContext): ResolvedLocation | null;

  /** Scroll to and briefly emphasise a location. */
  revealLocation(location: DocumentLocation): Promise<void>;

  /** Surrounding text for a location, used for search snippets and peek previews. */
  getSearchContext(location: DocumentLocation): Promise<SearchContext>;
}

/** Where the extractor reads bytes from. Paths never cross into the renderer. */
export interface ExtractionSource {
  /** Absolute path, main process only. */
  path: string;
  mimeType: string;
  contentHash: string;
}

/** What an adapter needs to create or resolve an anchor. */
export interface AnchorContext {
  /** Content hash of the revision currently rendered. */
  contentHash: string;
  /**
   * Normalized text of the relevant container: the page for PDFs, the article body for
   * HTML. Supplied by the reader, which owns the rendering.
   */
  containerText: string;
  /** For PDFs, which page `containerText` belongs to. */
  pageIndex?: number;
}
