import { describe, expect, it } from 'vitest';
import {
  INLINE_CONSTRUCT_RE,
  flattenInline,
  parseMarkdown,
  resolveWikilinks,
  slugForFilename,
  slugify,
  type WikilinkTarget,
} from './markdown.js';

const index = (...entries: readonly WikilinkTarget[]): Map<string, WikilinkTarget> =>
  new Map(entries.map((entry) => [entry.slug, entry]));

describe('slugs', () => {
  it('slugs page names the way GitHub and Foam do', () => {
    expect(slugify('Field Station')).toBe('field-station');
    expect(slugify('Ground Truth & Corpus')).toBe('ground-truth--corpus');
    expect(slugify('  Spaced  Out  ')).toBe('spaced-out');
  });

  it('addresses a corpus file by its basename, not its directory', () => {
    expect(slugForFilename('notes/Field Station.md')).toBe('field-station');
    expect(slugForFilename('/abs/path/READING LIST.markdown')).toBe('reading-list');
  });
});

describe('parseMarkdown', () => {
  it('collects headings with their slug paths', () => {
    const parsed = parseMarkdown('# Results\n\ntext\n\n## Ablations\n\nmore\n');
    expect(parsed.title).toBe('Results');
    expect(parsed.headings.map((h) => h.headingPath)).toEqual(['results', 'results/ablations']);
  });

  it('projects prose, not markup, into the searchable text', () => {
    const parsed = parseMarkdown('# Title\n\nSome **bold** and `code` and a [link](http://x).\n');
    expect(parsed.text).toContain('Some bold and code and a link');
    expect(parsed.text).not.toContain('**');
  });

  it('chunks by top-level section so a search hit knows which section it came from', () => {
    const parsed = parseMarkdown('# One\n\nalpha\n\n# Two\n\nbeta\n');
    expect(parsed.chunks).toHaveLength(2);
    expect(parsed.chunks[0]?.sectionPath).toBe('one');
    expect(parsed.chunks[0]?.text).toContain('alpha');
    expect(parsed.chunks[1]?.sectionPath).toBe('two');
    expect(parsed.chunks[1]?.text).toContain('beta');
  });

  it('[W06] parses [[slug]] from the AST with its source offsets', () => {
    const source = 'See [[Field Station]] for context.\n';
    const parsed = parseMarkdown(source);
    expect(parsed.wikilinks).toHaveLength(1);
    const link = parsed.wikilinks[0];
    expect(link?.target).toBe('Field Station');
    expect(link?.slug).toBe('field-station');
    expect(source.slice(link?.sourceStart ?? 0, link?.sourceEnd ?? 0)).toBe('[[Field Station]]');
  });

  it('[W06] ignores [[slug]] inside a fenced code block', () => {
    const source = [
      'Real link to [[Alpha]].',
      '',
      '```markdown',
      'This [[Beta]] is documentation of the syntax, not a link.',
      '```',
      '',
      'Inline `[[Gamma]]` is code too.',
      '',
      '    [[Delta]] is an indented code block.',
      '',
    ].join('\n');
    const slugs = parseMarkdown(source).wikilinks.map((link) => link.slug);
    expect(slugs).toEqual(['alpha']);
  });

  it('[W06] reads aliases and section targets', () => {
    const parsed = parseMarkdown('[[Field Station#Ground Truth|the boundary]] matters.\n');
    const link = parsed.wikilinks[0];
    expect(link?.slug).toBe('field-station');
    expect(link?.section).toBe('ground-truth');
    expect(link?.alias).toBe('the boundary');
  });

  it('[W06] records the heading a link appears under', () => {
    const parsed = parseMarkdown('# Top\n\n## Method\n\nUses [[Alpha]].\n');
    expect(parsed.wikilinks[0]?.headingPath).toBe('top/method');
  });

  it('[W06] resolves a wikilink to the document that owns its slug', () => {
    const parsed = parseMarkdown('Refer to [[Field Station]] and [[Missing Page]].\n');
    const target: WikilinkTarget = {
      documentId: 'doc_a',
      slug: 'field-station',
      title: 'Field Station',
    };
    const resolution = resolveWikilinks(
      [{ documentId: 'doc_source', wikilinks: parsed.wikilinks }],
      index(target),
    );
    expect(resolution.resolved).toHaveLength(1);
    expect(resolution.resolved[0]?.target.documentId).toBe('doc_a');
    expect(resolution.resolved[0]?.link.slug).toBe('field-station');
  });

  it('flattens wikilink syntax to what the reader sees', () => {
    expect(flattenInline('a [[Page|alias]] b')).toBe('a alias b');
    expect(flattenInline('a [[Page]] b')).toBe('a Page b');
    // The chip is labelled with the target; the section decides where a click lands.
    expect(flattenInline('a [[Page#Part two]] b')).toBe('a Page b');
  });
});

describe('wanted pages', () => {
  it('[W08] lists an unresolved [[slug]] as a wanted page rather than failing', () => {
    const parsed = parseMarkdown('Later: [[Ground Truth]].\n');
    const resolution = resolveWikilinks(
      [{ documentId: 'doc_source', wikilinks: parsed.wikilinks }],
      index(),
    );
    expect(resolution.resolved).toEqual([]);
    expect(resolution.wanted).toEqual([
      { slug: 'ground-truth', title: 'Ground Truth', referencedBy: ['doc_source'], count: 1 },
    ]);
  });

  it('[W08] counts every reference to a wanted page and lists each referrer once', () => {
    const a = parseMarkdown('[[Ground Truth]] and again [[ground truth]].\n');
    const b = parseMarkdown('Also [[Ground Truth]].\n');
    const resolution = resolveWikilinks(
      [
        { documentId: 'doc_a', wikilinks: a.wikilinks },
        { documentId: 'doc_b', wikilinks: b.wikilinks },
      ],
      index(),
    );
    expect(resolution.wanted).toHaveLength(1);
    expect(resolution.wanted[0]?.count).toBe(3);
    expect(resolution.wanted[0]?.referencedBy).toEqual(['doc_a', 'doc_b']);
  });

  it('[W08] a page written later stops being wanted without anything being rewritten', () => {
    const parsed = parseMarkdown('Later: [[Ground Truth]].\n');
    const sources = [{ documentId: 'doc_source', wikilinks: parsed.wikilinks }];
    expect(resolveWikilinks(sources, index()).wanted).toHaveLength(1);

    const withPage = resolveWikilinks(
      sources,
      index({ documentId: 'doc_gt', slug: 'ground-truth', title: 'Ground Truth' }),
    );
    expect(withPage.wanted).toEqual([]);
    expect(withPage.resolved[0]?.target.documentId).toBe('doc_gt');
  });

  it('[W08] a wikilink inside a code fence never becomes a wanted page', () => {
    const parsed = parseMarkdown('```\n[[Never Wanted]]\n```\n');
    expect(resolveWikilinks([{ documentId: 'doc', wikilinks: parsed.wikilinks }], index()).wanted)
      .toEqual([]);
  });
});

/**
 * The shared inline rule is the one expression both processes run, and one of them owns the
 * database.
 *
 * `parseMarkdown` runs on every block of every markdown file the corpus importer reads, in the
 * main process, synchronously, beside a better-sqlite3 handle. So the cost of this expression
 * on a hostile file is not a rendering nicety — it is how long the whole application answers
 * nothing. The wikilink target used to admit `[`, which is its own opening delimiter, and a run
 * of them made it quadratic: 8,000 characters took 385 ms and 64,000 took 22 seconds.
 *
 * The budget below is deliberately loose. It is not a benchmark — it is the difference between
 * linear and quadratic, which on this input is three orders of magnitude, and it has to stay
 * green on a machine that is also running an Electron build.
 */
describe('the inline construct rule on a hostile file', () => {
  const MAX_MS = 1_000;

  const elapsed = (source: string): number => {
    const started = performance.now();
    parseMarkdown(source);
    return performance.now() - started;
  };

  it('parses a long run of its own opening delimiter in linear time', () => {
    // 22 seconds before, and it is the main process, so nothing else answers for 22 seconds.
    expect(elapsed(`${'['.repeat(64_000)}\n`)).toBeLessThan(MAX_MS);
  });

  it('does not backtrack after an opening delimiter it cannot close', () => {
    expect(elapsed(`[[a#${'['.repeat(32_000)}\n`)).toBeLessThan(MAX_MS);
    expect(elapsed(`[[a|${'['.repeat(32_000)}\n`)).toBeLessThan(MAX_MS);
    expect(elapsed(`${'[['.repeat(16_000)}\n`)).toBeLessThan(MAX_MS);
  });

  it('is linear in the maths delimiters too, which is where the rule came from', () => {
    expect(elapsed(`${'$'.repeat(64_000)}\n`)).toBeLessThan(MAX_MS);
    expect(elapsed(`${'$x'.repeat(32_000)}\n`)).toBeLessThan(MAX_MS);
  });

  /**
   * The exclusion is only sound because it changes nothing a document can express. A target
   * may hold any character but `]`, a newline, `|`, `#` and now `[` — and a `[` there was never
   * a wikilink anyone wrote, only the parser's own delimiter read as content.
   */
  it('still matches every construct it matched before', () => {
    const matches = (source: string): unknown[] => {
      INLINE_CONSTRUCT_RE.lastIndex = 0;
      return [...source.matchAll(INLINE_CONSTRUCT_RE)].map((match) => [
        match.index,
        match[0],
        match[1],
        match[2],
        match[3],
        match[4],
        match[5],
      ]);
    };

    expect(matches('[[Page]]')).toEqual([[0, '[[Page]]', 'Page', undefined, undefined, undefined, undefined]]);
    expect(matches('[[Page#part|alias]]')).toEqual([
      [0, '[[Page#part|alias]]', 'Page', 'part', 'alias', undefined, undefined],
    ]);
    expect(matches('a [[A]] and [[B|c]] end').map((match) => (match as unknown[])[0])).toEqual([2, 12]);
    expect(matches('$$x$$ and $y$ and $5 and $10').map((match) => (match as unknown[])[1])).toEqual([
      '$$x$$',
      '$y$',
    ]);
    // The one shape that reads differently, and it reads better: the stray delimiter is not
    // part of the name of a page.
    expect(matches('[[[Page]]')).toEqual([[1, '[[Page]]', 'Page', undefined, undefined, undefined, undefined]]);
  });
});
