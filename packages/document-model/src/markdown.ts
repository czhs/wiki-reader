/**
 * Markdown parsing: headings, sections, plain text and `[[wikilinks]]`.
 *
 * Everything here works from the mdast produced by `remark-parse` (+ GFM), never from a
 * regex sweep over the source. That distinction is the whole point: `[[link]]` inside a
 * fenced code block is *code*, and a wrong edge in the graph looks like a finding rather
 * than like a bug. A code fence is a `code` node, so it is never visited as prose, and the
 * exclusion holds structurally instead of by pattern.
 *
 * Slugs come from `github-slugger`, the same slugger Foam and Obsidian's ecosystem use, so a
 * corpus stays readable in those tools and `[[Some Page]]` resolves to `some-page.md`.
 *
 * This module is renderer-safe: no filesystem, no database, no DOM.
 */
import GithubSlugger from 'github-slugger';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { toString as mdastToString } from 'mdast-util-to-string';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import type { Heading, Root, RootContent, Text } from 'mdast';
import type { ExtractedChunk } from '@wr/shared-types';
import { textHash } from './hash.js';
import { normalizeText, normalizeTextPreservingParagraphs } from './normalize.js';

/** Bumped when the shape of `parseMarkdown`'s text projection changes. */
export const MARKDOWN_PARSER_VERSION = 1;

const processor = unified().use(remarkParse).use(remarkGfm);

export interface MarkdownHeading {
  /** 1 for `#`, 6 for `######`. */
  readonly depth: number;
  readonly text: string;
  /** GitHub-compatible slug of this heading alone. */
  readonly slug: string;
  /** Slash-joined slugs of this heading and its ancestors. */
  readonly headingPath: string;
  /** Offset of the heading in the *source*. */
  readonly sourceOffset: number;
}

export interface MarkdownWikilink {
  /** Target as written, before slugging: `Some Page` in `[[Some Page|alias]]`. */
  readonly target: string;
  /** Normalized target used for resolution. */
  readonly slug: string;
  /** `#section` part, slugged, when the link names one. */
  readonly section: string | null;
  /** Display text when the link is aliased with `|`. */
  readonly alias: string | null;
  /** Offsets of the whole `[[...]]` construct in the source. */
  readonly sourceStart: number;
  readonly sourceEnd: number;
  /** Heading path the link appears under, "" at the top of the document. */
  readonly headingPath: string;
}

export interface ParsedMarkdown {
  /** Plain text with paragraph structure, what the reader would read aloud. */
  readonly text: string;
  /** Normalized projection of `text`; every anchor offset indexes into this. */
  readonly normalizedText: string;
  readonly textHash: string;
  readonly headings: readonly MarkdownHeading[];
  readonly wikilinks: readonly MarkdownWikilink[];
  /** One chunk per top-level section, for FTS and search-result locations. */
  readonly chunks: readonly ExtractedChunk[];
  /** First level-1 heading, when the document opens with one. */
  readonly title: string | null;
}

/**
 * Slugify a page name or heading the way GitHub (and therefore Foam) does.
 *
 * A fresh slugger per call because `GithubSlugger` deduplicates across a run — reusing one
 * would turn a second `[[Notes]]` into `notes-1` and break resolution.
 */
export function slugify(input: string): string {
  // Whitespace is collapsed first: the slugger maps each space to a dash, so `[[ Field
  // Station ]]` would otherwise slug to `--field-station--` and fail to resolve against the
  // page it plainly names.
  return new GithubSlugger().slug(input.trim().replace(/\s+/g, ' '));
}

/**
 * The slug a corpus file is addressed by: its basename, slugged.
 *
 * `notes/Field Station.md` is `[[Field Station]]`, i.e. `field-station`. The directory is
 * deliberately not part of the slug — Foam and Obsidian address pages by name, not by path.
 */
export function slugForFilename(filename: string): string {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? filename;
  return slugify(base.replace(/\.(md|markdown|mdx)$/i, ''));
}

/**
 * `[[target]]`, `[[target|alias]]`, `[[target#section]]`, `[[target#section|alias]]`.
 *
 * Applied only to the source text covered by mdast `text` nodes, never to the whole file.
 */
const WIKILINK_RE = /\[\[([^\]\n|#]+)(?:#([^\]\n|]+))?(?:\|([^\]\n]*))?\]\]/g;

/** Parse a markdown document. */
export function parseMarkdown(source: string): ParsedMarkdown {
  const tree = processor.parse(source) as Root;

  const headings = collectHeadings(tree);
  const wikilinks = collectWikilinks(tree, source, headings);
  const { text, chunks } = projectText(tree, source, headings);
  const normalizedText = normalizeText(text);

  return {
    text,
    normalizedText,
    textHash: textHash(normalizedText),
    headings,
    wikilinks,
    chunks,
    title: firstTitle(tree),
  };
}

function firstTitle(tree: Root): string | null {
  for (const node of tree.children) {
    if (node.type === 'heading' && node.depth === 1) return mdastToString(node).trim();
  }
  return null;
}

function collectHeadings(tree: Root): MarkdownHeading[] {
  // One slugger for the document, so two identically-named headings get `x` and `x-1` —
  // the same disambiguation GitHub applies, which is what makes an anchor unambiguous.
  const slugger = new GithubSlugger();
  const stack: MarkdownHeading[] = [];
  const out: MarkdownHeading[] = [];

  visit(tree, 'heading', (node: Heading) => {
    const text = mdastToString(node).trim();
    const slug = slugger.slug(text);
    while (stack.length > 0 && (stack[stack.length - 1]?.depth ?? 0) >= node.depth) stack.pop();
    const parent = stack[stack.length - 1];
    const headingPath = parent === undefined ? slug : `${parent.headingPath}/${slug}`;
    const heading: MarkdownHeading = {
      depth: node.depth,
      text,
      slug,
      headingPath,
      sourceOffset: node.position?.start.offset ?? 0,
    };
    stack.push(heading);
    out.push(heading);
  });

  return out;
}

/** The heading path in effect at a source offset. */
function headingPathAt(headings: readonly MarkdownHeading[], offset: number): string {
  let current = '';
  for (const heading of headings) {
    if (heading.sourceOffset > offset) break;
    current = heading.headingPath;
  }
  return current;
}

function collectWikilinks(
  tree: Root,
  source: string,
  headings: readonly MarkdownHeading[],
): MarkdownWikilink[] {
  const out: MarkdownWikilink[] = [];

  visit(tree, 'text', (node: Text) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;

    // Scan the *source* slice rather than `node.value`: the parsed value has character
    // references decoded and backslash escapes removed, so an offset into it would not be an
    // offset into the file. The slice is bounded by the node, so a fence is still excluded.
    const slice = source.slice(start, end);
    WIKILINK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WIKILINK_RE.exec(slice)) !== null) {
      const target = (match[1] ?? '').trim();
      if (target.length === 0) continue;
      const rawSection = match[2]?.trim();
      const alias = match[3]?.trim();
      out.push({
        target,
        slug: slugify(target),
        section: rawSection === undefined || rawSection.length === 0 ? null : slugify(rawSection),
        alias: alias === undefined || alias.length === 0 ? null : alias,
        sourceStart: start + match.index,
        sourceEnd: start + match.index + match[0].length,
        headingPath: headingPathAt(headings, start + match.index),
      });
    }
  });

  return out;
}

/**
 * Project the document to prose plus one chunk per top-level section.
 *
 * The projection is what search indexes and what anchors measure against; it is never the
 * reading view. Wikilink syntax is flattened to its display text so a search for the alias
 * matches what the reader sees, and a fenced block contributes its code as text rather than
 * disappearing — a corpus of notes about code is mostly code.
 */
function projectText(
  tree: Root,
  source: string,
  headings: readonly MarkdownHeading[],
): { text: string; chunks: ExtractedChunk[] } {
  const blocks = tree.children.map((node) => ({
    node,
    text: blockToText(node, source),
  }));

  let text = '';
  const chunks: ExtractedChunk[] = [];
  let sectionStart = 0;
  let sectionPath = '';
  let sectionIndex = 0;

  const flush = (endOffset: number): void => {
    if (endOffset <= sectionStart) return;
    chunks.push({
      index: sectionIndex,
      kind: 'markdown-section',
      text: normalizeTextPreservingParagraphs(text.slice(sectionStart, endOffset)),
      charStart: sectionStart,
      charEnd: endOffset,
      ...(sectionPath === '' ? {} : { sectionPath }),
    });
    sectionIndex += 1;
  };

  for (const block of blocks) {
    if (block.text.length === 0) continue;
    const isTopHeading = block.node.type === 'heading' && block.node.depth <= 2;
    if (isTopHeading && text.length > sectionStart) {
      flush(text.length);
      sectionStart = text.length;
    }
    if (block.node.type === 'heading') {
      const offset = block.node.position?.start.offset ?? 0;
      sectionPath = headingPathAt(headings, offset);
    }
    text += text.length === 0 ? block.text : `\n\n${block.text}`;
  }

  flush(text.length);
  return { text, chunks };
}

/** One top-level block as prose. */
function blockToText(node: RootContent, source: string): string {
  if (node.type === 'code') return node.value.trim();
  if (node.type === 'thematicBreak') return '';
  if (node.type === 'html') return '';
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  const raw = start === undefined || end === undefined ? '' : source.slice(start, end);
  const flattened = mdastToString(node).trim();
  // `mdast-util-to-string` keeps `[[a|b]]` verbatim because it is ordinary text; showing the
  // alias (or the target) is what a reader sees in the rendered document.
  return flattenWikilinks(flattened.length > 0 ? flattened : raw);
}

/** Replace `[[target|alias]]` with the text a reader sees. */
export function flattenWikilinks(input: string): string {
  WIKILINK_RE.lastIndex = 0;
  return input.replace(WIKILINK_RE, (_match, target: string, section?: string, alias?: string) => {
    if (typeof alias === 'string' && alias.trim().length > 0) return alias.trim();
    const base = target.trim();
    return typeof section === 'string' && section.trim().length > 0
      ? `${base} ${section.trim()}`
      : base;
  });
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface WikilinkTarget {
  readonly documentId: string;
  readonly slug: string;
  readonly title: string;
}

export interface ResolvedWikilink {
  readonly link: MarkdownWikilink;
  readonly target: WikilinkTarget;
}

/**
 * A `[[slug]]` nothing in the corpus answers.
 *
 * Foam calls these "placeholders", Obsidian "unresolved links"; both treat them as an
 * ordinary part of writing — you link the page you intend to write. Reporting one as an
 * error would make a wiki-in-progress look broken, so they are collected, counted, and
 * offered as pages worth creating.
 */
export interface WantedPage {
  readonly slug: string;
  /** The target text as first written, for the "create this page" affordance. */
  readonly title: string;
  /** Document ids that link to it, deduplicated, in first-seen order. */
  readonly referencedBy: readonly string[];
  readonly count: number;
}

export interface WikilinkResolution {
  readonly resolved: readonly ResolvedWikilink[];
  readonly wanted: readonly WantedPage[];
}

/**
 * Resolve the wikilinks of one or more documents against a slug index.
 *
 * Self-links resolve like any other: a page may reference itself, and dropping the edge
 * would make the graph disagree with the text.
 */
export function resolveWikilinks(
  sources: ReadonlyArray<{ documentId: string; wikilinks: readonly MarkdownWikilink[] }>,
  index: ReadonlyMap<string, WikilinkTarget>,
): WikilinkResolution {
  const resolved: ResolvedWikilink[] = [];
  const wanted = new Map<string, { title: string; referencedBy: string[]; count: number }>();

  for (const source of sources) {
    for (const link of source.wikilinks) {
      const target = index.get(link.slug);
      if (target !== undefined) {
        resolved.push({ link, target });
        continue;
      }
      const existing = wanted.get(link.slug);
      if (existing === undefined) {
        wanted.set(link.slug, {
          title: link.target,
          referencedBy: [source.documentId],
          count: 1,
        });
      } else {
        existing.count += 1;
        if (!existing.referencedBy.includes(source.documentId)) {
          existing.referencedBy.push(source.documentId);
        }
      }
    }
  }

  return {
    resolved,
    wanted: [...wanted.entries()].map(([slug, entry]) => ({
      slug,
      title: entry.title,
      referencedBy: entry.referencedBy,
      count: entry.count,
    })),
  };
}
