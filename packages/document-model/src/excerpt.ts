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
import { AnnotationIdSchema } from '@wr/shared-types';
import { formatInternalLink } from './internal-links.js';

/** Every line prefixed, so a quote that runs over several lines is still one blockquote. */
function quoteLines(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`.replace(/\s+$/, ''))
    .join('\n');
}

/**
 * `]` and `[` in a title would end the link text early, and a newline would end the link.
 * Escaped rather than stripped: the title is somebody's file and it should read as itself.
 */
function linkText(title: string): string {
  const collapsed = title.replace(/\s+/gu, ' ').trim();
  return collapsed === ''
    ? 'the highlight'
    : collapsed.replace(/([[\]\\])/gu, '\\$1');
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
  const label = linkText(excerpt.sourceTitle);
  if (!parsed.success) return `${quoted}\n>\n> — ${label}`;
  const href = formatInternalLink({ scheme: 'annotation', annotationId: parsed.data });
  return `${quoted}\n>\n> — [${label}](${href})`;
}
