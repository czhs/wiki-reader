/**
 * The desk's data, moved into the pages it belonged to (criterion P06).
 *
 * The desk board was never a store. A card *was* a `question-references-…` edge and nothing
 * else, and the edges are untouched here — they are what the graph, the ledger and the
 * references panel read. What retiring the board loses is the only place those edges were ever
 * *shown*, so this pass gives each of them a block on the page it was made on: a paper as its
 * name, a highlight as the sentence it marks, both carrying the internal link that navigates.
 *
 * Three properties it has to have, and each of them is a bug this file exists to avoid:
 *
 * - **Idempotent.** It runs at every start, and a second run must not double a researcher's
 *   page. Two guards: a setting that records it has been done, and `appendNotebookBlocks`,
 *   which skips a block whose internal link the page already has. The second is the load-
 *   bearing one — it holds even against a database restored from a backup taken mid-pass.
 * - **Additive.** Blocks go on the end. Nothing already written is rewritten, reordered or
 *   removed, and an empty page ends up holding exactly what its desk held.
 * - **Silent about paths.** It reads titles and marked text out of the database and writes
 *   `document://` and `annotation://`, which is all a page is ever allowed to carry.
 *
 * It lives in main rather than as a SQL migration because what a landing block reads as is a
 * decision about markdown — escaping, attribution, the shape of a quote — and that decision
 * already exists once, in `@wr/document-model`. Spelling it a second time in SQL is how the
 * two would drift.
 */
import type { WikiReaderDatabase } from '@wr/database';
import { documentReferenceMarkdown, excerptMarkdown } from '@wr/document-model';

/** Set once the pass has run. Its presence is a fast path, never the correctness argument. */
export const DESK_RETIRED_SETTING = 'notebook.deskRetired';

interface RetirementLogger {
  info: (event: string, fields?: Record<string, unknown>) => void;
  warn: (event: string, fields?: Record<string, unknown>) => void;
}

/**
 * The markdown one retired card becomes, or `null` when its other end has gone.
 *
 * A broken card was drawn as a card with a hole in it. There is no such thing as a block with
 * a hole in it, and inventing prose for a paper that is no longer in the library would put a
 * sentence on the page that the researcher never wrote — so it is left as the edge it is.
 */
function cardAsBlock(db: WikiReaderDatabase, link: {
  readonly type: string;
  readonly targetId: string;
}): string | null {
  if (link.type === 'question-references-document') {
    const document = db.documents.getById(link.targetId);
    if (document === null) return null;
    return documentReferenceMarkdown({ documentId: document.id, title: document.title });
  }
  if (link.type === 'question-references-annotation') {
    const annotation = db.annotations.get(link.targetId);
    if (annotation === null) return null;
    const source = db.documents.getById(annotation.documentId);
    return excerptMarkdown({
      annotationId: annotation.id,
      selectedText: annotation.selectedText,
      sourceTitle: source?.title ?? '',
    });
  }
  return null;
}

/**
 * Land every desk card as a block on its notebook's page. Returns how many blocks were added.
 *
 * `appendBlocks` is passed in rather than imported so that this shares the *one* implementation
 * of "add blocks to a page" with the drop and the send — a second copy of the joining rule is
 * how a page ends up with two spellings of a blank line between blocks.
 */
export function retireTheDesk(
  db: WikiReaderDatabase,
  appendBlocks: (questionId: string, blocks: readonly string[]) => number,
  logger: RetirementLogger,
): number {
  if (db.settings.get(DESK_RETIRED_SETTING) === true) return 0;

  let added = 0;
  try {
    for (const question of db.questions.list()) {
      const blocks = db.links
        .findReferences({ entityType: 'question', entityId: question.id, direction: 'outgoing' })
        .filter((link) => link.type.startsWith('question-references-'))
        .flatMap((link) => {
          const block = cardAsBlock(db, { type: link.type, targetId: link.targetId });
          return block === null ? [] : [block];
        });
      added += appendBlocks(question.id, blocks);
    }
    db.settings.set(DESK_RETIRED_SETTING, true);
  } catch (error) {
    // A page that could not be written is not a reason to refuse to start: the edges are all
    // still there, the setting is not written, and the next start tries again.
    logger.warn('the desk could not be retired into pages', { error: String(error) });
    return added;
  }
  if (added > 0) logger.info('desk cards landed as blocks', { added });
  return added;
}
