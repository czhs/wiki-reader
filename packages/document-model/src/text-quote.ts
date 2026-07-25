import type {
  AnchorMatchStrategy,
  TextPositionSelector,
  TextQuoteSelector,
} from '@wr/shared-types';

/**
 * Resolution of a W3C TextQuoteSelector against a container's normalized text.
 *
 * Strategy, in order:
 *   1. `exact-position`  — the recorded offsets still hold the recorded quote.
 *   2. `quote-relocated` — the quote occurs elsewhere; pick the occurrence whose
 *                          prefix/suffix context matches best, breaking ties by
 *                          proximity to the original offset.
 *   3. `context-fuzzy`   — no exact occurrence; slide a window to find the position
 *                          minimising edit distance to the quote, accepting only if
 *                          similarity clears a threshold.
 *
 * Returning `null` is a legitimate outcome and must be surfaced as a broken anchor, not
 * silently swallowed.
 */

export const DEFAULT_CONTEXT_LENGTH = 32;

/** Similarity below which a fuzzy match is rejected. */
export const FUZZY_ACCEPT_THRESHOLD = 0.75;

export interface QuoteResolution {
  position: TextPositionSelector;
  strategy: AnchorMatchStrategy;
  confidence: number;
}

/** Build a quote selector for `text[start,end)` with surrounding context. */
export function createQuoteSelector(
  text: string,
  start: number,
  end: number,
  contextLength: number = DEFAULT_CONTEXT_LENGTH,
): TextQuoteSelector {
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - contextLength), start),
    suffix: text.slice(end, Math.min(text.length, end + contextLength)),
  };
}

/** Every index at which `needle` occurs in `haystack`. */
function allIndexesOf(haystack: string, needle: string): number[] {
  if (needle.length === 0) return [];
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    out.push(index);
    from = index + 1;
  }
  return out;
}

/** Length of the longest common suffix of `a` and `b`. */
function commonSuffixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) {
    n += 1;
  }
  return n;
}

/** Length of the longest common prefix of `a` and `b`. */
function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) {
    n += 1;
  }
  return n;
}

/**
 * Score a candidate occurrence by how much of the recorded context it reproduces.
 * Returns 0..1, where 1 means both prefix and suffix match completely.
 */
function scoreContext(
  text: string,
  candidateStart: number,
  candidateEnd: number,
  quote: TextQuoteSelector,
): number {
  const wantedPrefix = quote.prefix;
  const wantedSuffix = quote.suffix;
  const total = wantedPrefix.length + wantedSuffix.length;
  if (total === 0) return 1;

  const actualPrefix = text.slice(Math.max(0, candidateStart - wantedPrefix.length), candidateStart);
  const actualSuffix = text.slice(candidateEnd, candidateEnd + wantedSuffix.length);

  const matched =
    commonSuffixLength(actualPrefix, wantedPrefix) + commonPrefixLength(actualSuffix, wantedSuffix);
  return matched / total;
}

/** Levenshtein distance with an early-exit ceiling. */
export function levenshtein(a: string, b: string, ceiling = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > ceiling) return ceiling + 1;

  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = current[0] ?? i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      const substitution = (previous[j - 1] ?? 0) + cost;
      const best = Math.min(deletion, insertion, substitution);
      current[j] = best;
      if (best < rowMin) rowMin = best;
    }
    if (rowMin > ceiling) return ceiling + 1;
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length] ?? 0;
}

/** 1 - normalized edit distance, clamped to 0..1. */
export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  const ceiling = Math.ceil(longest * (1 - FUZZY_ACCEPT_THRESHOLD)) + 1;
  const distance = levenshtein(a, b, ceiling);
  return Math.max(0, 1 - distance / longest);
}

/**
 * Resolve `quote` against `text`.
 *
 * @param hint The originally recorded offsets, used to check the fast path and to break
 *             ties between equally well-contextualised occurrences.
 */
export function resolveTextQuote(
  text: string,
  quote: TextQuoteSelector,
  hint?: TextPositionSelector,
): QuoteResolution | null {
  const { exact } = quote;
  if (exact.length === 0) return null;

  // 1 & 2. The quote still occurs verbatim. Score every occurrence by how much of the
  //        recorded context it reproduces, then decide whether to stay at the recorded
  //        offsets or relocate.
  //
  //        Staying put is not automatically correct: when a document contains the same
  //        sentence twice, the recorded offsets can still hold the quote while the
  //        context says the anchor belongs to the *other* copy. Context wins.
  const occurrences = allIndexesOf(text, exact);
  if (occurrences.length > 0) {
    const hintStart = hint?.start ?? 0;
    const scored = occurrences.map((start) => ({
      start,
      score: scoreContext(text, start, start + exact.length, quote),
      distance: Math.abs(start - hintStart),
    }));

    const bestScore = scored.reduce((max, c) => (c.score > max ? c.score : max), -1);
    const TIE_EPSILON = 1e-9;
    const tied = scored.filter((c) => c.score >= bestScore - TIE_EPSILON);
    // Context is only *distinguishing* when exactly one occurrence achieves the best score.
    const ambiguityPenalty = tied.length > 1 ? 0.8 : 1;

    const best =
      tied.reduce<(typeof scored)[number] | null>(
        (acc, c) => (acc === null || c.distance < acc.distance ? c : acc),
        null,
      ) ?? scored[0];

    if (best === undefined) return null;

    const hintHoldsQuote =
      hint !== undefined && text.slice(hint.start, hint.end) === exact;

    if (hintHoldsQuote && hint !== undefined) {
      const hintScore = scoreContext(text, hint.start, hint.end, quote);
      // Keep the recorded offsets unless another occurrence matches the context better.
      if (hintScore >= bestScore - TIE_EPSILON) {
        return {
          position: { start: hint.start, end: hint.end },
          strategy: 'exact-position',
          confidence: (0.9 + 0.1 * hintScore) * ambiguityPenalty,
        };
      }
    }

    return {
      position: { start: best.start, end: best.start + exact.length },
      strategy: 'quote-relocated',
      confidence: (0.7 + 0.3 * best.score) * ambiguityPenalty,
    };
  }

  // 3. Fuzzy: slide a window the size of the quote and minimise edit distance.
  //    Anchored around the hint when we have one, to bound the cost on long documents.
  const windowSize = exact.length;
  if (windowSize > text.length) return null;

  const searchRadius = 4000;
  const center = hint?.start ?? Math.floor(text.length / 2);
  const from = hint === undefined ? 0 : Math.max(0, center - searchRadius);
  const to =
    hint === undefined
      ? text.length - windowSize
      : Math.min(text.length - windowSize, center + searchRadius);

  // Step by a fraction of the quote length for a coarse pass, then refine locally.
  const coarseStep = Math.max(1, Math.floor(windowSize / 4));
  let coarseBest = -1;
  let coarseBestStart = -1;
  for (let start = from; start <= to; start += coarseStep) {
    const score = similarity(text.slice(start, start + windowSize), exact);
    if (score > coarseBest) {
      coarseBest = score;
      coarseBestStart = start;
    }
  }
  if (coarseBestStart < 0) return null;

  let bestScore = coarseBest;
  let bestStart = coarseBestStart;
  const refineFrom = Math.max(from, coarseBestStart - coarseStep);
  const refineTo = Math.min(to, coarseBestStart + coarseStep);
  for (let start = refineFrom; start <= refineTo; start += 1) {
    const score = similarity(text.slice(start, start + windowSize), exact);
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }

  if (bestScore < FUZZY_ACCEPT_THRESHOLD) return null;

  const contextScore = scoreContext(text, bestStart, bestStart + windowSize, quote);
  return {
    position: { start: bestStart, end: bestStart + windowSize },
    strategy: 'context-fuzzy',
    confidence: Math.min(0.7, bestScore * (0.6 + 0.4 * contextScore)),
  };
}
