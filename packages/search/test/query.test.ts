import { describe, expect, it } from 'vitest';
import { parseQuery, parseQueryTerms, quoteFts5 } from '../src/query.js';

/**
 * The property under test is that no user byte ever reaches FTS5 unquoted. A search box is
 * a raw text input; if a stray quote or a bare operator could reach the MATCH expression, an
 * ordinary query like `say "hello` would surface to the user as an FTS5 syntax error.
 */
describe('query parsing', () => {
  it('[T07] requires every bare term, quoted as an FTS5 literal', () => {
    const parsed = parseQuery('quantum theory');
    expect(parsed.expression).toBe('"quantum" AND "theory"');
    expect(parsed.terms).toEqual(['quantum', 'theory']);
    expect(parsed.isEmpty).toBe(false);
  });

  it('[T07] keeps a double-quoted run together as one phrase term', () => {
    const parsed = parseQuery('"dark matter" halo');
    expect(parsed.expression).toBe('"dark matter" AND "halo"');
    expect(parsed.terms).toEqual(['dark matter', 'halo']);
  });

  it('[T07] emits OR between the terms the user alternated', () => {
    expect(parseQuery('cats OR dogs').expression).toBe('"cats" OR "dogs"');
  });

  it('[T07] treats a bare AND as the implicit default rather than a search term', () => {
    expect(parseQuery('cats AND dogs').expression).toBe('"cats" AND "dogs"');
    expect(parseQuery('cats AND dogs').terms).toEqual(['cats', 'dogs']);
  });

  it('[T07] negates with both the - prefix and the NOT keyword', () => {
    expect(parseQuery('attention -review').expression).toBe('"attention" NOT "review"');
    expect(parseQuery('attention NOT review').expression).toBe('"attention" NOT "review"');
    // A negation is not something to highlight in the result snippet.
    expect(parseQuery('attention -review').terms).toEqual(['attention']);
  });

  it('[T07] restricts a term to one column when the user writes a column prefix', () => {
    expect(parseQuery('title:entropy').expression).toBe('{title} : "entropy"');
    expect(parseQuery('body:entropy diffusion').expression).toBe(
      '{body} : "entropy" AND "diffusion"',
    );
  });

  it('[T07] applies a dangling column prefix to the following phrase', () => {
    expect(parseQuery('title: "dark matter"').expression).toBe('{title} : "dark matter"');
  });

  it('[T07] treats an unknown column prefix as ordinary query text', () => {
    // `author:` is not an indexed column, so it must not silently drop the user's filter
    // intent by matching everything — it stays part of the literal term.
    const parsed = parseQuery('author:vaswani');
    expect(parsed.expression).toBe('"author:vaswani"');
  });

  it('[T07] escapes embedded double quotes instead of letting them break the expression', () => {
    expect(quoteFts5('say "hi"')).toBe('"say ""hi"""');
    const parsed = parseQuery('say "hi');
    expect(parsed.expression).toBe('"say" AND "hi"');
  });

  it('[T07] neutralises FTS5 syntax that appears inside a user term', () => {
    // Every one of these characters is an FTS5 operator. Unquoted they would be a syntax
    // error or, worse, a silently different query than the user asked for.
    const parsed = parseQuery('c++ (a*b) NEAR/2');
    for (const term of parsed.terms) {
      expect(parsed.expression).toContain(quoteFts5(term));
    }
    expect(parsed.expression).not.toMatch(/(^|\s)[(*)](\s|$)/);
  });

  it('[T07] reports an empty query for blank input and for operators alone', () => {
    for (const input of ['', '   ', 'AND', 'OR', 'NOT', '-review']) {
      expect(parseQuery(input).isEmpty).toBe(true);
      expect(parseQuery(input).expression).toBe('');
    }
  });

  it('[T07] appends a prefix wildcard to the last word only when asked', () => {
    expect(parseQuery('quantum ent', { prefixLastTerm: true }).expression).toBe(
      '"quantum" AND "ent"*',
    );
    expect(parseQuery('quantum ent').expression).toBe('"quantum" AND "ent"');
    // A completed phrase is not a word in progress, so it is never made a prefix match.
    expect(parseQuery('"dark matter"', { prefixLastTerm: true }).expression).toBe('"dark matter"');
  });

  it('[T07] records the modifiers it parsed for each term', () => {
    const terms = parseQueryTerms('title:entropy -review "dark matter"');
    expect(terms).toEqual([
      { text: 'entropy', phrase: false, negated: false, column: 'title' },
      { text: 'review', phrase: false, negated: true, column: null },
      { text: 'dark matter', phrase: true, negated: false, column: null },
    ]);
  });
});
