/**
 * Markdown anchors: create one from a selection, resolve one against current text.
 *
 * A markdown file is text the user owns and edits in other tools, so there is no geometry to
 * fall back on and no revision the app controls. The evidence is therefore entirely textual —
 * the quote, its offsets into the normalized document text, and hashes of both the text and
 * the file. When the file is unchanged the offsets are authoritative; when it has been edited
 * the quote is re-found with its surrounding context, and a highlight that cannot be found
 * resolves to `null` rather than to a plausible-looking wrong paragraph.
 */
import {
  MarkdownAnchorSchema,
  type MarkdownAnchor,
  type MarkdownLocation,
  type MarkdownReaderSelection,
  type ResolvedLocation,
} from '@wr/shared-types';
import { taggedTextHash } from './hash.js';
import { NORMALIZATION_VERSION, normalizeText } from './normalize.js';
import { createQuoteSelector, locateNearest, resolveTextQuote } from './text-quote.js';

export const MARKDOWN_ANCHOR_VERSION = 1;

export interface CreateMarkdownAnchorOptions {
  readonly selection: MarkdownReaderSelection;
  /** Content hash of the markdown file the selection was made against. */
  readonly sourceHash: string;
  readonly contextLength?: number;
}

export function createMarkdownAnchor(options: CreateMarkdownAnchorOptions): MarkdownAnchor {
  const { selection, sourceHash, contextLength } = options;

  // The reader hands over its own view of the text; normalize before deriving anything so the
  // offsets and hash agree with what resolution will recompute later.
  const documentText = normalizeText(selection.documentText);
  const exact = normalizeText(selection.text);
  const position = locateNearest(documentText, exact, selection.position.start);
  const quote = createQuoteSelector(documentText, position.start, position.end, contextLength);

  return MarkdownAnchorSchema.parse({
    kind: 'markdown',
    version: MARKDOWN_ANCHOR_VERSION,
    quote: { ...quote, exact },
    position,
    documentTextHash: taggedTextHash(documentText),
    sourceHash,
    normalizationVersion: NORMALIZATION_VERSION,
    ...(selection.headingPath === undefined ? {} : { headingPath: selection.headingPath }),
  } satisfies MarkdownAnchor);
}

export interface ResolveMarkdownAnchorOptions {
  readonly anchor: MarkdownAnchor;
  /** Raw or normalized text of the document as it is now. */
  readonly documentText: string;
  /** Content hash of the file being rendered, when known. */
  readonly sourceHash?: string;
}

/** Resolve an anchor against the document's current text, or `null` when it is lost. */
export function resolveMarkdownAnchor(
  options: ResolveMarkdownAnchorOptions,
): ResolvedLocation | null {
  const { anchor, sourceHash } = options;
  const documentText = normalizeText(options.documentText);

  const textUnchanged = taggedTextHash(documentText) === anchor.documentTextHash;
  const fileUnchanged = sourceHash === undefined || sourceHash === anchor.sourceHash;

  if (textUnchanged && fileUnchanged) {
    return {
      location: locationFor(anchor, anchor.position),
      strategy: 'exact-position',
      confidence: 1,
    };
  }

  const resolution = resolveTextQuote(documentText, anchor.quote, anchor.position);
  if (resolution === null) return null;
  return {
    location: locationFor(anchor, resolution.position),
    strategy: resolution.strategy,
    confidence: resolution.confidence,
  };
}

function locationFor(
  anchor: MarkdownAnchor,
  position: { start: number; end: number },
): MarkdownLocation {
  return {
    kind: 'markdown',
    textRange: position,
    quote: anchor.quote,
    ...(anchor.headingPath === undefined ? {} : { headingPath: anchor.headingPath }),
  };
}

export function deserializeMarkdownAnchor(json: string): MarkdownAnchor {
  return MarkdownAnchorSchema.parse(JSON.parse(json));
}
