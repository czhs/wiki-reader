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
import { createQuoteSelector, resolveTextQuote } from './text-quote.js';

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
  const position = locate(documentText, exact, selection.position.start);
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

/**
 * Find `exact`, preferring the occurrence nearest the reader's hint.
 *
 * A short quote ("the") occurs many times; the hint is what distinguishes the one the user
 * actually dragged over from the first one in the file.
 */
function locate(
  documentText: string,
  exact: string,
  hintStart: number,
): { start: number; end: number } {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let from = 0;
  for (;;) {
    const index = documentText.indexOf(exact, from);
    if (index === -1) break;
    const distance = Math.abs(index - hintStart);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
    from = index + 1;
  }
  if (best === -1) {
    const start = Math.min(hintStart, Math.max(0, documentText.length - exact.length));
    return { start, end: start + exact.length };
  }
  return { start: best, end: best + exact.length };
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

export function serializeMarkdownAnchor(anchor: MarkdownAnchor): string {
  return JSON.stringify(MarkdownAnchorSchema.parse(anchor));
}

export function deserializeMarkdownAnchor(json: string): MarkdownAnchor {
  return MarkdownAnchorSchema.parse(JSON.parse(json));
}
