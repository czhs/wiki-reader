/**
 * User query text -> FTS5 MATCH expression.
 *
 * Everything the user types is untrusted with respect to FTS5 syntax: a stray `"` or a bare
 * `AND` would otherwise raise `fts5: syntax error near ...` and surface as a failed search
 * rather than as no results. So no user bytes ever reach FTS5 unquoted — every term is
 * emitted as a quoted string, and the only operators in the output are ones this parser
 * decided to emit.
 *
 * Supported input syntax:
 *   quantum theory        both terms required (implicit AND)
 *   "dark matter"         phrase
 *   cats OR dogs          alternation
 *   -review / NOT review  negation
 *   title:entropy         restrict a term to one indexed column
 */

/** Columns of `search_fts`, in declaration order. */
export const SEARCH_COLUMNS = ['title', 'body', 'meta'] as const;
export type SearchColumn = (typeof SEARCH_COLUMNS)[number];

export interface QueryTerm {
  /** The literal text to match. Never contains FTS5 syntax by the time it is emitted. */
  readonly text: string;
  /** True when the user wrote it inside double quotes. */
  readonly phrase: boolean;
  readonly negated: boolean;
  /** Restrict this term to a single column, or null to search all of them. */
  readonly column: SearchColumn | null;
}

export interface ParsedQuery {
  /** The FTS5 MATCH expression. Empty when the query has no searchable terms. */
  readonly expression: string;
  /** Positive terms, for caller-side highlighting. Excludes negations. */
  readonly terms: readonly string[];
  readonly isEmpty: boolean;
}

export interface ParseQueryOptions {
  /**
   * Append `*` to the final positive term so an in-flight word matches as the user types.
   * Off for committed searches, on for the search-as-you-type box.
   */
  readonly prefixLastTerm?: boolean;
}

const OPERATOR_ALTERNATION = 'OR';
const OPERATOR_NEGATION = 'NOT';

/** FTS5 string literal: wrap in double quotes, double any embedded double quote. */
export function quoteFts5(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function isSearchColumn(value: string): value is SearchColumn {
  return (SEARCH_COLUMNS as readonly string[]).includes(value);
}

interface RawToken {
  readonly value: string;
  readonly quoted: boolean;
}

/**
 * Split on whitespace, keeping double-quoted runs together.
 *
 * An unterminated quote is treated as running to the end of the input rather than as an
 * error: the user is probably still typing.
 */
function tokenize(input: string): RawToken[] {
  const tokens: RawToken[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index];
    if (char === undefined || /\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '"') {
      const end = input.indexOf('"', index + 1);
      const value = end === -1 ? input.slice(index + 1) : input.slice(index + 1, end);
      if (value.trim().length > 0) tokens.push({ value: value.trim(), quoted: true });
      index = end === -1 ? input.length : end + 1;
      continue;
    }

    let end = index;
    while (end < input.length) {
      const next = input[end];
      if (next === undefined || /\s/.test(next) || next === '"') break;
      end += 1;
    }
    // `title:"two words"` — the prefix stops at the quote, which the next pass picks up.
    const value = input.slice(index, end);
    if (value.length > 0) tokens.push({ value, quoted: false });
    index = end === index ? index + 1 : end;
  }

  return tokens;
}

/** Strip a leading `-` and/or a `column:` prefix from a bare token. */
function splitModifiers(raw: string): {
  text: string;
  negated: boolean;
  column: SearchColumn | null;
} {
  let text = raw;
  let negated = false;
  let column: SearchColumn | null = null;

  if (text.startsWith('-') && text.length > 1) {
    negated = true;
    text = text.slice(1);
  }

  const colon = text.indexOf(':');
  if (colon > 0) {
    const candidate = text.slice(0, colon).toLowerCase();
    if (isSearchColumn(candidate)) {
      column = candidate;
      text = text.slice(colon + 1);
    }
  }

  return { text, negated, column };
}

export function parseQueryTerms(input: string): QueryTerm[] {
  const tokens = tokenize(input);
  const terms: QueryTerm[] = [];
  let pendingNegation = false;
  let pendingColumn: SearchColumn | null = null;

  for (const token of tokens) {
    if (!token.quoted) {
      const upper = token.value.toUpperCase();
      // Bare operators are control words, not search terms.
      if (upper === OPERATOR_ALTERNATION || upper === 'AND') continue;
      if (upper === OPERATOR_NEGATION) {
        pendingNegation = true;
        continue;
      }
      // A trailing `title:` applies to the next token, e.g. `title: "dark matter"`.
      if (token.value.endsWith(':')) {
        const candidate = token.value.slice(0, -1).toLowerCase();
        if (isSearchColumn(candidate)) {
          pendingColumn = candidate;
          continue;
        }
      }
    }

    const modifiers = token.quoted
      ? { text: token.value, negated: false, column: null }
      : splitModifiers(token.value);

    if (modifiers.text.trim().length === 0) continue;

    terms.push({
      text: modifiers.text.trim(),
      phrase: token.quoted || modifiers.text.includes(' '),
      negated: modifiers.negated || pendingNegation,
      column: modifiers.column ?? pendingColumn,
    });
    pendingNegation = false;
    pendingColumn = null;
  }

  return terms;
}

/** Positions of `OR` between terms, so alternation binds the pair around it. */
function alternationAfter(input: string, terms: readonly QueryTerm[]): boolean[] {
  const flags = new Array<boolean>(terms.length).fill(false);
  const tokens = tokenize(input);
  let termIndex = -1;

  for (const token of tokens) {
    if (!token.quoted && token.value.toUpperCase() === OPERATOR_ALTERNATION) {
      if (termIndex >= 0 && termIndex < flags.length) flags[termIndex] = true;
      continue;
    }
    if (!token.quoted) {
      const upper = token.value.toUpperCase();
      if (upper === 'AND' || upper === OPERATOR_NEGATION) continue;
      if (token.value.endsWith(':') && isSearchColumn(token.value.slice(0, -1).toLowerCase())) {
        continue;
      }
    }
    termIndex += 1;
  }

  return flags;
}

export function parseQuery(input: string, options: ParseQueryOptions = {}): ParsedQuery {
  const terms = parseQueryTerms(input);
  const positives = terms.filter((term) => !term.negated);

  if (positives.length === 0) {
    // A query of nothing but negations cannot be ranked; FTS5 needs a positive match.
    return { expression: '', terms: [], isEmpty: true };
  }

  const alternates = alternationAfter(input, terms);
  const lastPositiveIndex = terms.reduce(
    (found, term, index) => (term.negated ? found : index),
    -1,
  );

  const parts: string[] = [];
  terms.forEach((term, index) => {
    const prefixable =
      options.prefixLastTerm === true && index === lastPositiveIndex && !term.phrase;
    const literal = quoteFts5(term.text) + (prefixable ? '*' : '');
    const scoped = term.column === null ? literal : `{${term.column}} : ${literal}`;

    if (parts.length === 0) {
      // A negation with nothing to its left has nothing to subtract from, so it is dropped
      // rather than emitted as a bare `NOT x`, which FTS5 rejects.
      if (!term.negated) parts.push(scoped);
      return;
    }
    parts.push(term.negated ? 'NOT' : alternates[index - 1] === true ? 'OR' : 'AND', scoped);
  });

  const expression = parts.join(' ').trim();
  return {
    expression,
    terms: positives.map((term) => term.text),
    isEmpty: expression.length === 0,
  };
}
