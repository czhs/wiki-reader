/**
 * A highlight, quoted into a markdown document (criterion S03).
 *
 * An excerpt is **markdown**, not a private node type: a blockquote holding the sentence as
 * it was marked, and one `annotation://` link back to where it came from. That is the whole
 * design decision. A ProseMirror node would have been invisible to search, to the librarian
 * and to anyone opening the file in a text editor, and a notebook page is a markdown document
 * exactly so that none of those lose sight of it.
 *
 * The link is what makes it an excerpt rather than a copy: the id survives the text being
 * re-flowed, the source being re-read, or the quote being edited, and the renderer turns it
 * into a chip that navigates back to the marked sentence.
 */
import { AnnotationIdSchema, DocumentIdSchema } from '@wr/shared-types';
import { collapseWhitespace } from './display.js';
import { formatInternalLink } from './internal-links.js';

/**
 * The quote is **text**, not markup, and the text came out of a document.
 *
 * `selectedText` is the one input here that a PDF or a page off the open web controls, and a
 * blockquote's contents are ordinary markdown — so without this a highlight reading
 * `— [Ebbinghaus 1885](annotation://ann_…)` renders a second attribution chip above the real
 * one, pointing wherever the document said. `S03` is the criterion that the excerpt *keeps its
 * link to the source*; letting the source dictate what the provenance line says is the one way
 * to break it from inside. `> ` prefixing is a block rule and was never an escape.
 *
 * Only the characters that begin a construct, and each only where it can begin one, so the raw
 * markdown the researcher edits still reads as their sentence: a backslash escape is invisible
 * once rendered, but a quoted paper full of `\\`s would not be. So `#` and `-` are escaped
 * where they lead a line and nowhere else, and `_` is escaped only when it is not between two
 * word characters — `emphasis` needs a flank and `file_9` is a name, which is the same rule
 * CommonMark applies. `*` gets no such relief: it opens emphasis mid-word too.
 *
 * Two things escaping cannot reach, both bounded elsewhere and neither a link: `$…$` — the
 * renderer's inline pass runs on mdast `text` values, after markdown has already consumed
 * `\\$`, so a formula in a quote still draws as MathML, capped by `MAX_USER_SIZE_EM` — and a
 * bare `https://…`, which GFM autolinks with no punctuation to escape and which the window
 * refuses to navigate to anyway.
 */
function quoteText(text: string): string {
  return text
    .replace(/([\\`*[\]<~|])/gu, '\\$1')
    .replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, '\\_')
    .replace(/^(\s*)([#+=>:-])/gmu, '$1\\$2')
    .replace(/^(\s*\d+)([.)])/gmu, '$1\\$2');
}

/** Every line prefixed, so a quote that runs over several lines is still one blockquote. */
function quoteLines(text: string): string {
  return quoteText(text)
    .split('\n')
    .map((line) => `> ${line}`.replace(/\s+$/, ''))
    .join('\n');
}

/**
 * `]` and `[` in a title would end the link text early, and a newline would end the link.
 * Escaped rather than stripped: the title is somebody's file and it should read as itself.
 */
function linkText(title: string, whenNameless: string): string {
  const collapsed = collapseWhitespace(title);
  return collapsed === '' ? whenNameless : collapsed.replace(/([[\]\\])/gu, '\\$1');
}

/**
 * The markdown for one excerpt block.
 *
 * Deliberately one block: `parseBlocks` splits on blank lines, and a `>` line is not blank,
 * so the quote and its attribution stay a single thing the researcher clicks into and edits
 * as a unit.
 */
export function excerptMarkdown(excerpt: {
  readonly annotationId: string;
  readonly selectedText: string;
  readonly sourceTitle: string;
}): string {
  const parsed = AnnotationIdSchema.safeParse(excerpt.annotationId);
  const body = excerpt.selectedText.trim();
  const quoted = body === '' ? '>' : quoteLines(body);
  const label = linkText(excerpt.sourceTitle, 'the highlight');
  if (!parsed.success) return `${quoted}\n>\n> — ${label}`;
  const href = formatInternalLink({ scheme: 'annotation', annotationId: parsed.data });
  return `${quoted}\n>\n> — [${label}](${href})`;
}

/**
 * The markdown for a whole file landing in a page (`P06`).
 *
 * The desk is retired and what used to be a card on it is now a **block in the page**, so a
 * paper sent or dropped onto a notebook has to arrive as something the researcher can read,
 * edit and write around. Its counterpart is `excerptMarkdown`: a highlight lands as the
 * sentence, a file lands as its name — and both carry an internal link, which is what makes
 * either of them a reference rather than a copy of a title.
 *
 * One line, and no blank line in it, so `parseBlocks` keeps it as one block. The title is
 * escaped the same way an excerpt's attribution is, because a file called `Notes [draft]`
 * would otherwise close the link text early and leave half a citation on the page.
 */
export function documentReferenceMarkdown(reference: {
  readonly documentId: string;
  readonly title: string;
}): string {
  const parsed = DocumentIdSchema.safeParse(reference.documentId);
  const label = linkText(reference.title, 'the file');
  if (!parsed.success) return label;
  const href = formatInternalLink({ scheme: 'document', documentId: parsed.data });
  return `[${label}](${href})`;
}
