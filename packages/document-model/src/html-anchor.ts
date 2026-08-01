/**
 * Web-snapshot anchors: create one from a selection, resolve one against the page as it is now.
 *
 * A saved page is bytes the app captured and does not edit, which sounds like it should make
 * anchoring trivial — offsets into a file that never changes. It does not, for two reasons.
 *
 * The offsets are not into the file. They are into the *text extracted from* the file, and
 * that extraction is code that changes: a fix to `extractHtmlText` that stops emitting a
 * `<figcaption>` twice moves every offset after it in every page ever saved. So the anchor
 * records `normalizationVersion` and carries its quote, and resolution re-finds the quote
 * whenever the recorded offsets no longer hold the recorded words.
 *
 * And the snapshot can be replaced. Re-saving a page that has since been edited gives a
 * different archive under the same document, which is `snapshotHash` — the same role
 * `sourceHash` plays for a markdown file the user edits in another tool.
 *
 * `readerMode` is carried through untouched and is not a detail. Offsets taken over the
 * original markup and offsets taken over Readability's extracted article are different
 * coordinate systems that happen to have the same shape, and silently resolving one against
 * the other would land a highlight on unrelated words with full confidence.
 */
import {
  HtmlAnchorSchema,
  type HtmlAnchor,
  type HtmlLocation,
  type HtmlReaderSelection,
  type ResolvedLocation,
} from '@wr/shared-types';
import { htmlAnchorToLocation } from './anchor-location.js';
import { NORMALIZATION_VERSION, normalizeText } from './normalize.js';
import { createQuoteSelector, locateNearest, resolveTextQuote } from './text-quote.js';

export const HTML_ANCHOR_VERSION = 1;

export interface CreateHtmlAnchorOptions {
  readonly selection: HtmlReaderSelection;
  /** Content hash of the archived snapshot the selection was made against. */
  readonly snapshotHash: string;
  readonly contextLength?: number;
}

export function createHtmlAnchor(options: CreateHtmlAnchorOptions): HtmlAnchor {
  const { selection, snapshotHash, contextLength } = options;

  // Normalize before deriving anything, so the offsets and the quote agree with what
  // resolution recomputes later from the bytes on disk.
  const containerText = normalizeText(selection.containerText);
  const exact = normalizeText(selection.text);
  const position = locateNearest(containerText, exact, selection.position.start);
  const quote = createQuoteSelector(containerText, position.start, position.end, contextLength);

  return HtmlAnchorSchema.parse({
    kind: 'html',
    version: HTML_ANCHOR_VERSION,
    quote: { ...quote, exact },
    position,
    snapshotHash,
    readerMode: selection.readerMode,
    normalizationVersion: NORMALIZATION_VERSION,
    ...(selection.sectionPath === undefined ? {} : { sectionPath: selection.sectionPath }),
    ...(selection.domFallback === undefined ? {} : { domFallback: selection.domFallback }),
  } satisfies HtmlAnchor);
}

export interface ResolveHtmlAnchorOptions {
  readonly anchor: HtmlAnchor;
  /** Raw or normalized text extracted from the snapshot as it is now. */
  readonly documentText: string;
  /** Content hash of the snapshot being rendered, when known. */
  readonly snapshotHash?: string;
  /** Which rendering `documentText` came from. Defaults to the anchor's own. */
  readonly readerMode?: HtmlAnchor['readerMode'];
}

/** Resolve an anchor against the snapshot's current text, or `null` when it is lost. */
export function resolveHtmlAnchor(options: ResolveHtmlAnchorOptions): ResolvedLocation | null {
  const { anchor, snapshotHash, readerMode } = options;

  // A different rendering is a different coordinate system, not a moved highlight. There is
  // nothing to relocate against, and pretending otherwise is how an anchor lands confidently
  // on the wrong words.
  if (readerMode !== undefined && readerMode !== anchor.readerMode) return null;

  const documentText = normalizeText(options.documentText);
  const snapshotUnchanged = snapshotHash === undefined || snapshotHash === anchor.snapshotHash;

  // The offsets are trusted only when they still hold the words they were recorded for.
  // Checking the text rather than a hash of it is what makes this survive a change to
  // extraction: the archive is identical, the extracted text is not, and the quote is the
  // only evidence that stayed true.
  const atPosition = documentText.slice(anchor.position.start, anchor.position.end);
  if (snapshotUnchanged && atPosition === anchor.quote.exact) {
    return { location: htmlAnchorToLocation(anchor), strategy: 'exact-position', confidence: 1 };
  }

  const resolution = resolveTextQuote(documentText, anchor.quote, anchor.position);
  if (resolution === null) return null;
  const relocated: HtmlLocation = {
    ...htmlAnchorToLocation(anchor),
    textRange: resolution.position,
  };
  return {
    location: relocated,
    strategy: resolution.strategy,
    confidence: resolution.confidence,
  };
}

export function deserializeHtmlAnchor(json: string): HtmlAnchor {
  return HtmlAnchorSchema.parse(JSON.parse(json));
}
