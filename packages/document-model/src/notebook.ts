import { parseMarkdown } from './markdown.js';

/**
 * The sections of a field notebook page (criterion N02).
 *
 * The body is markdown *source*, stored as typed. Fieldstation began by storing rendered
 * HTML from a `contenteditable` and had to migrate away from it, because prose in a store
 * that only one editor can read is prose nothing else can touch. Nothing in this module
 * rewrites a body; it only reads structure out of one.
 *
 * The four conventional headings are a template, not a schema. A page that drops one is
 * still a page, a page that adds three more is still a page, and a page of free prose with
 * no headings at all is still a page.
 */

/**
 * What a blank page opens on. Convention, borrowed from the notebook being migrated.
 *
 * The first section was called "The question" until milestone 5 retired that word: the
 * researcher does not know what a question is, and the section was always asking what they
 * want to know. Renaming the heading changes nothing already written — a body is stored as
 * typed, and only a page nobody has opened yet gets the new template.
 */
export const NOTEBOOK_TEMPLATE_SECTIONS = [
  'What I want to know',
  'Background and prior work',
  'Hypotheses',
  'Experiment log',
] as const;

export interface NotebookSection {
  /** The heading text as written. Empty for prose that precedes the first heading. */
  readonly heading: string;
  /** GitHub-compatible slug, the same one wikilinks resolve `#section` against. */
  readonly slug: string;
  /** 1 for `#`, 2 for `##`. 0 for the anonymous leading section. */
  readonly depth: number;
  /** Source under the heading, up to the next section, with surrounding blank lines cut. */
  readonly body: string;
}

/**
 * A page's opening state.
 *
 * Deliberately without a `# title`: the page's name is the notebook's title, and a copy of
 * it in the body would be a second place to rename and a second thing to get out of step.
 */
export function blankNotebook(): string {
  return `${NOTEBOOK_TEMPLATE_SECTIONS.map((heading) => `## ${heading}\n`).join('\n')}`;
}

/**
 * The page's sections, in the order they are written.
 *
 * Headings come from the markdown AST the rest of the app already parses with, so a `##`
 * inside a code fence is text, not a section — which is the difference between reading a
 * page and guessing at one.
 *
 * A page's sections are its *shallowest* headings: a notebook written with `#` throughout
 * has the same shape as one written with `##`, and the sub-headings under a section stay
 * inside it.
 */
export function notebookSections(source: string): NotebookSection[] {
  if (source.trim() === '') return [];

  const { headings } = parseMarkdown(source);
  const topDepth = headings.reduce<number | null>(
    (min, heading) => (min === null || heading.depth < min ? heading.depth : min),
    null,
  );
  const tops = topDepth === null ? [] : headings.filter((heading) => heading.depth === topDepth);

  const sections: NotebookSection[] = [];

  // Prose written above the first heading is a section of the page too. Reporting nothing
  // would hide it from an outline; giving it a heading would put words in the page.
  const firstStart = tops[0]?.sourceOffset ?? source.length;
  const preamble = source.slice(0, firstStart).trim();
  if (preamble !== '') {
    sections.push({ heading: '', slug: '', depth: 0, body: preamble });
  }

  tops.forEach((heading, index) => {
    const end = tops[index + 1]?.sourceOffset ?? source.length;
    sections.push({
      heading: heading.text,
      slug: heading.slug,
      depth: heading.depth,
      body: source.slice(endOfHeading(source, heading.sourceOffset), end).trim(),
    });
  });

  return sections;
}

/**
 * Where the heading itself stops and its section begins.
 *
 * `## Heading` ends at its newline; a setext heading is underlined on a second line, so it
 * ends at the newline after that.
 */
function endOfHeading(source: string, offset: number): number {
  const lines = source.startsWith('#', offset) ? 1 : 2;
  let cursor = offset;
  for (let i = 0; i < lines; i += 1) {
    const newline = source.indexOf('\n', cursor);
    if (newline === -1) return source.length;
    cursor = newline + 1;
  }
  return cursor;
}
