/**
 * The wiki, as the librarian sees it.
 *
 * The wiki is the whole app — the papers, the saved pages, the notes, the questions, the
 * journal. Most of it lives in SQLite, and a headless `claude` cannot read SQLite. So it is
 * materialised as a directory of markdown the agent can `Glob`, `Grep` and `Read` its way
 * through, following `[[wikilinks]]` from one file to the next.
 *
 * Two properties of this module are load-bearing.
 *
 * **Whole documents, always** (`A11`). A document's text is written out entire: every chunk of
 * its latest revision, in order, with nothing dropped and nothing summarised. There is no
 * query parameter, no limit, no relevance, and nothing here imports `@wr/search`. That is the
 * point of the design and the thing most likely to be helpfully undone — "the corpus is bigger
 * than the context, add retrieval" is the reflex answer, and top-k ranking decides what is
 * related *before* the model thinks, which is the judgement the librarian exists to make.
 *
 * **Read-only** (`A02`, second half). Everything outside the workspace is read-only to the
 * agent, and the agent is spawned with `--add-dir` on this directory, which would otherwise
 * permit writing. So the tree is left `r-x`/`r--` on disk: the refusal happens in the kernel,
 * below any tool, and does not depend on the agent having read the prompt.
 */
import { chmod, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { WikiReaderDatabase } from '@wr/database';
import type { Document } from '@wr/shared-types';
import type { Logger } from '../logger.js';

const DIR_READ_ONLY = 0o555;
const FILE_READ_ONLY = 0o444;
const DIR_WRITABLE = 0o755;

export interface WikiViewOptions {
  readonly db: WikiReaderDatabase;
  /** Where the view is built. Wiped and rebuilt on every pass; nothing else may live here. */
  readonly root: string;
  readonly logger: Logger;
}

export interface WikiViewSummary {
  readonly root: string;
  readonly documents: number;
  readonly questions: number;
  readonly journalEntries: number;
  readonly notes: number;
  readonly annotations: number;
  /** Total characters of document text written. Whole documents make this large on purpose. */
  readonly characters: number;
}

export class WikiView {
  readonly #db: WikiReaderDatabase;
  readonly #root: string;
  readonly #logger: Logger;

  constructor(options: WikiViewOptions) {
    if (!isAbsolute(options.root)) throw new Error('The wiki view root must be absolute.');
    this.#db = options.db;
    this.#root = resolve(options.root);
    this.#logger = options.logger.child('wiki-view');
  }

  get root(): string {
    return this.#root;
  }

  /**
   * Rebuild the view from the database.
   *
   * Rebuilt rather than updated: the view is derived, a stale corner of it would be a lie
   * about the wiki, and the cost of writing it is trivial next to the cost of a run.
   */
  async materialise(): Promise<WikiViewSummary> {
    await this.#clear();
    await mkdir(this.#root, { recursive: true });

    const summary = {
      documents: 0,
      questions: 0,
      journalEntries: 0,
      notes: 0,
      annotations: 0,
      characters: 0,
    };

    const documents = this.#db.documents.list({ limit: 10_000 }).items;
    for (const document of documents) {
      const text = this.#wholeText(document.id);
      await this.#writeFile(join('documents', `${document.id}.md`), this.#documentPage(document, text));
      summary.documents += 1;
      summary.characters += text.length;

      const annotations = this.#db.annotations.listByDocument(document.id);
      if (annotations.length > 0) {
        await this.#writeFile(
          join('annotations', `${document.id}.md`),
          this.#annotationsPage(document, annotations),
        );
        summary.annotations += annotations.length;
      }
    }

    for (const question of this.#db.questions.list()) {
      await this.#writeFile(join('questions', `${question.id}.md`), this.#questionPage(question));
      summary.questions += 1;
    }

    // A day is filed under the notebook it belongs to (`P02`). Flat by date, as this was,
    // two notebooks written in on the same afternoon would overwrite each other here — the
    // librarian would read one and never know the other existed.
    for (const entry of this.#db.journal.listAll()) {
      await this.#writeFile(
        join('journal', entry.notebookId, `${entry.date}.md`),
        `---\ndate: ${entry.date}\nnotebook: ${entry.notebookId}\ntype: journal\n---\n\n${entry.markdown}\n`,
      );
      summary.journalEntries += 1;
    }

    for (const note of this.#db.notes.list(10_000).notes) {
      await this.#writeFile(
        join('notes', `${note.id}.md`),
        `---\nid: ${note.id}\ntitle: ${escapeYaml(note.title)}\ntype: note\n---\n\n${note.contentText}\n`,
      );
      summary.notes += 1;
    }

    await this.#writeFile('README.md', readme(summary));
    await this.#sealReadOnly(this.#root);

    this.#logger.info('wiki view materialised', { ...summary, root: this.#root });
    return { root: this.#root, ...summary };
  }

  /**
   * Delete the view.
   *
   * Needed because a sealed tree cannot be removed by an ordinary `rm -rf`: a read-only
   * directory refuses to have entries unlinked from it. So the app cannot leave the view to
   * be cleaned up by anything that does not know it was sealed — when agents are switched
   * off, this is what takes the copy of the wiki back off disk.
   */
  async remove(): Promise<void> {
    await this.#clear();
  }

  /**
   * A document's extracted text, whole.
   *
   * Chunks exist because FTS5 needs passages with locations, not because a reader wants
   * fragments. Joined back in `chunk_index` order this is the document as extracted — the
   * same text, in the same order, with the page boundaries kept as markers so a citation can
   * name a page.
   */
  #wholeText(documentId: string): string {
    const revision = this.#db.revisions.latestForDocument(documentId);
    const chunks =
      revision === null
        ? this.#db.chunks.listForDocument(documentId)
        : this.#db.chunks.listForRevision(revision.id);

    return chunks
      .map((chunk) => {
        const marker =
          chunk.pageIndex !== null
            ? `\n\n<!-- page ${chunk.pageIndex + 1} -->\n\n`
            : chunk.sectionPath !== null
              ? `\n\n<!-- ${chunk.sectionPath} -->\n\n`
              : '\n\n';
        return `${marker}${chunk.text}`;
      })
      .join('')
      .trimStart();
  }

  #documentPage(document: Document, text: string): string {
    const authors = document.authors
      .map((author) =>
        author.literal ?? [author.given, author.family].filter(Boolean).join(' ').trim(),
      )
      .filter((name) => name.length > 0);
    const references = this.#db.externalReferences.listForEntity('document', document.id);
    const front = [
      '---',
      `id: ${document.id}`,
      `title: ${escapeYaml(document.title)}`,
      `type: ${document.docType}`,
      `source: ${document.source}`,
      ...(document.slug === null ? [] : [`slug: ${escapeYaml(document.slug)}`]),
      ...(authors.length === 0 ? [] : [`authors: ${escapeYaml(authors.join('; '))}`]),
      ...(document.publishedDate === null ? [] : [`published: ${escapeYaml(document.publishedDate)}`]),
      ...references.map(
        (reference) => `${reference.provider}: ${escapeYaml(reference.externalKey)}`,
      ),
      '---',
      '',
      `# ${document.title}`,
      '',
    ];
    if (document.abstract !== null && document.abstract.length > 0) {
      front.push('## Abstract', '', document.abstract, '');
    }
    if (text.length === 0) {
      // Said plainly rather than left as an empty page. A document whose text has not been
      // extracted yet is a different fact from a document with nothing in it, and an agent
      // that cannot tell them apart will write a connection out of an absence.
      front.push('_No extracted text yet: this document has not been through extraction._', '');
      return front.join('\n');
    }
    front.push('## Full text', '', text, '');
    return front.join('\n');
  }

  #annotationsPage(
    document: Document,
    annotations: readonly { id: string; selectedText: string; comment: string | null }[],
  ): string {
    const lines = [
      '---',
      `document: ${document.id}`,
      'type: annotations',
      '---',
      '',
      `# Highlights in [[${document.id}]]`,
      '',
    ];
    for (const annotation of annotations) {
      lines.push(`## ${annotation.id}`, '', `> ${annotation.selectedText.replace(/\n/g, '\n> ')}`, '');
      if (annotation.comment !== null && annotation.comment.length > 0) {
        lines.push(annotation.comment, '');
      }
    }
    return lines.join('\n');
  }

  #questionPage(question: {
    id: string;
    title: string;
    status: string;
    importance: number | null;
    nextAction: string | null;
    discardedReason: string | null;
  }): string {
    const attached = this.#db.links.findReferences({
      entityType: 'question',
      entityId: question.id,
      direction: 'outgoing',
    });
    const lines = [
      '---',
      `id: ${question.id}`,
      `title: ${escapeYaml(question.title)}`,
      `status: ${question.status}`,
      'type: question',
      ...(question.importance === null ? [] : [`importance: ${question.importance}`]),
      '---',
      '',
      `# ${question.title}`,
      '',
    ];
    if (question.nextAction !== null) lines.push(`**Next action:** ${question.nextAction}`, '');
    if (question.discardedReason !== null) {
      lines.push(`**Discarded because:** ${question.discardedReason}`, '');
    }
    if (attached.length > 0) {
      lines.push('## Attached', '');
      for (const link of attached) lines.push(`- [[${link.targetId}]] (${link.type})`);
      lines.push('');
    }
    return lines.join('\n');
  }

  async #writeFile(relative: string, contents: string): Promise<void> {
    const target = join(this.#root, relative);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }

  /**
   * Remove the previous view.
   *
   * The tree was sealed read-only, and a read-only *directory* cannot have entries unlinked
   * from it, so the permissions have to be put back before anything can be deleted.
   */
  async #clear(): Promise<void> {
    try {
      await this.#unseal(this.#root);
    } catch {
      // Nothing there yet. `rm` below is a no-op in that case too.
    }
    await rm(this.#root, { recursive: true, force: true });
  }

  async #sealReadOnly(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) await this.#sealReadOnly(child);
      else await chmod(child, FILE_READ_ONLY);
    }
    // The directory last: sealing it first would make its own children unreachable.
    await chmod(directory, DIR_READ_ONLY);
  }

  async #unseal(directory: string): Promise<void> {
    await chmod(directory, DIR_WRITABLE);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) await this.#unseal(child);
    }
  }
}

/** Whether the view is sealed. Used by the test that asserts the agent cannot write to it. */
export async function isReadOnly(path: string): Promise<boolean> {
  const info = await stat(path);
  return (info.mode & 0o222) === 0;
}

function escapeYaml(value: string): string {
  return JSON.stringify(value);
}

function readme(summary: {
  documents: number;
  questions: number;
  journalEntries: number;
  notes: number;
}): string {
  return [
    '# The wiki',
    '',
    'Everything the researcher has read, asked and written. It is read-only to you.',
    '',
    `- \`documents/\` — ${summary.documents} papers, saved pages and notes, each with its full text.`,
    `- \`annotations/\` — the researcher's highlights, filed under the document they are in.`,
    `- \`questions/\` — ${summary.questions} research questions, in the order they are worked on.`,
    `- \`journal/\` — ${summary.journalEntries} dated entries.`,
    `- \`notes/\` — ${summary.notes} of the researcher's own notes.`,
    '',
    'Files are named by entity id, and `[[id]]` links between them are real. Start anywhere.',
    '',
  ].join('\n');
}
