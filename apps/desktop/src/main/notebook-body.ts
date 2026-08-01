/**
 * Writing into a notebook page's markdown, from the main process (criterion P06).
 *
 * A module of its own because three callers need it and one of them must not import the
 * others: the request handlers (a send, a drop), and the desk retirement pass, which runs from
 * `createServices` before any handler exists. Handlers already import `services.ts`, so putting
 * this there would close a cycle.
 *
 * It is the one place the main process appends prose to `questions.body`, so that "something
 * landed on this notebook" has a single spelling however it got there.
 */
import type { WikiReaderDatabase } from '@wr/database';

/** The internal link a landing block carries, which is what identifies it on the page. */
const INTERNAL_LINK_RE = /\((?:document|annotation|note):\/\/[^\s)]+\)/u;

/**
 * Add blocks to the end of a notebook's page, skipping the ones already on it.
 *
 * Skipping is by the block's own internal link rather than by a marker beside the document: a
 * page already referring to `annotation://ann_…` does not want a second copy of it, whether it
 * was quoted in by hand, sent twice, or carried over from the retired desk. That makes every
 * caller idempotent without any of them having to remember to be.
 *
 * Appended, never inserted: the researcher's own paragraphs keep their order, and a block that
 * arrives while they are typing is merged in the editor rather than replacing the draft. The
 * blank line between blocks is `parseBlocks`' one rule, and it is spelled here exactly once.
 *
 * Returns how many blocks were actually written, which is what the page is told.
 */
export function appendNotebookBlocks(
  db: WikiReaderDatabase,
  questionId: string,
  blocks: readonly string[],
): number {
  if (blocks.length === 0) return 0;
  const existing = db.questions.readBody(questionId) ?? '';
  const fresh: string[] = [];
  for (const block of blocks) {
    if (block.trim() === '') continue;
    const reference = INTERNAL_LINK_RE.exec(block)?.[0] ?? null;
    if (
      reference !== null &&
      (existing.includes(reference) || fresh.some((earlier) => earlier.includes(reference)))
    ) {
      continue;
    }
    fresh.push(block);
  }
  if (fresh.length === 0) return 0;
  const joined =
    existing.trim() === ''
      ? fresh.join('\n\n')
      : `${existing.replace(/\s+$/u, '')}\n\n${fresh.join('\n\n')}`;
  db.questions.writeBody(questionId, `${joined}\n`);
  return fresh.length;
}
