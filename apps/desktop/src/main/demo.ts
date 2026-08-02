/**
 * A demo library, for development only (criterion `B07`).
 *
 * Every surface in this application is a view of something the researcher made, which means an
 * empty installation shows fourteen empty panels. Working on the graph, the ledger, the journal
 * or the notebook page then starts with twenty minutes of typing before there is anything to
 * look at — so in practice they were worked on against whatever happened to be in a temporary
 * database, which is how a panel comes to be laid out for one row.
 *
 * This fills all of it in one action, and takes it away in one action. Four rules it is built
 * under, and each is a thing that could go wrong rather than a preference:
 *
 * - **Development only.** `available` is false in a packaged build and both channels refuse.
 *   The researcher's own library must not be able to grow six papers it never had.
 * - **Synthetic.** Nothing here is anybody's data. The papers are written for this file, the
 *   highlights are sentences out of them, and no fixture is copied from a real library.
 * - **Made the way real things are made.** The papers are markdown on disk, ingested by the
 *   *real* `MarkdownCorpusImporter` — same walk, same parse, same wikilinks, same index. A demo
 *   built by inserting rows would be a demo of a library the application cannot produce, which
 *   is exactly how a panel comes to be laid out for data that never occurs.
 * - **One predicate clears it.** Everything the demo makes is either a document tagged
 *   `DEMO_SOURCE`, a notebook whose id is on the demo's own list, or an edge with one of those
 *   at an end. There is no bookkeeping to drift: what was made is what is found.
 *
 * No Electron import, so the whole thing runs under vitest against a real database and real
 * markdown on disk.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import type { WikiReaderDatabase } from '@wr/database';
import { createMarkdownAnchor } from '@wr/document-model';
import type { SearchIndexer } from '@wr/search';
import { MarkdownCorpusImporter } from './corpus.js';
import type { AllowedRoots } from './paths.js';
import type { Logger } from './logger.js';

/** `Document.source` for every paper the demo library puts in. Never used by anything else. */
export const DEMO_SOURCE = 'demo';

/**
 * The notebooks and notes the demo made, remembered between runs.
 *
 * A document carries its origin in a column; a notebook and a note do not, and adding one to
 * three tables to support a development convenience would be the tail wagging the dog. So the
 * two ids the schema cannot answer for are written down — and *only* those two, so there is no
 * second account of the papers that could disagree with the column.
 */
const DEMO_SEED_SETTING = 'demo.seed';

const StoredSeedSchema = z.object({
  notebookIds: z.array(z.string()).default([]),
  noteIds: z.array(z.string()).default([]),
});

interface StoredSeed {
  readonly notebookIds: readonly string[];
  readonly noteIds: readonly string[];
}

function readSeed(db: WikiReaderDatabase): StoredSeed {
  const parsed = StoredSeedSchema.safeParse(db.settings.get(DEMO_SEED_SETTING));
  return parsed.success ? parsed.data : { notebookIds: [], noteIds: [] };
}

/** Raised when the demo is asked for in a packaged build. Nothing is written. */
export class DemoUnavailableError extends Error {
  constructor() {
    super('Demo content is a development thing, and this is not a development build.');
    this.name = 'DemoUnavailableError';
  }
}

export interface DemoStatus {
  /** False in a packaged build: both actions refuse and no surface offers them. */
  readonly available: boolean;
  /** True once there is demo content in this library. */
  readonly filled: boolean;
  readonly documents: number;
  readonly notebooks: number;
}

export interface DemoSummary {
  readonly documents: number;
  readonly notebooks: number;
  readonly highlights: number;
  readonly links: number;
  readonly journalDays: number;
  readonly notes: number;
}

export interface DemoLibraryOptions {
  readonly db: WikiReaderDatabase;
  /** Where the demo's markdown is written. Inside the allow-list, like every other root. */
  readonly root: string;
  readonly allowed: AllowedRoots;
  readonly indexer: SearchIndexer;
  /** False in a packaged build. The one thing that decides whether any of this can happen. */
  readonly available: boolean;
  readonly logger?: Logger | undefined;
}

/**
 * One synthetic paper: a markdown file, and the sentence a demo highlight is made over.
 *
 * The wikilinks between them are what give the graph its edges, so they are written the way a
 * researcher's own wiki is written rather than added afterwards as rows.
 */
interface DemoPaper {
  readonly slug: string;
  readonly title: string;
  readonly markdown: string;
  /** The sentence a highlight is made over, exactly as it appears in the projected text. */
  readonly quote?: string;
}

const PAPERS: readonly DemoPaper[] = [
  {
    slug: 'demo-attention-and-memory',
    title: 'Attention and memory in extended reading',
    quote: 'Readers who annotate recall roughly twice as much a week later.',
    markdown: [
      '# Attention and memory in extended reading',
      '',
      'Readers who annotate recall roughly twice as much a week later. The effect survives',
      'when the annotations are never read again, which is the part that is hard to explain',
      'by revision alone.',
      '',
      '## What is being measured',
      '',
      'Recall here is free recall of claims, not recognition of sentences. See',
      '[[demo-spacing-effects]] for the schedule the follow-ups used, and',
      '[[demo-note-taking-in-practice]] for what people actually do with a marked passage.',
      '',
      '## Limits',
      '',
      'Every study in this line is on undergraduates reading for an exam, which is not the',
      'reading this application is for.',
      '',
    ].join('\n'),
  },
  {
    slug: 'demo-spacing-effects',
    title: 'Spacing effects outside the laboratory',
    quote: 'Spacing wins on every interval anybody has bothered to measure.',
    markdown: [
      '# Spacing effects outside the laboratory',
      '',
      'Spacing wins on every interval anybody has bothered to measure. What changes with the',
      'interval is how much, not whether.',
      '',
      '## Field results',
      '',
      'Two reviews a week apart beat four in one afternoon, and the gap grows with the delay',
      'to the test. [[demo-attention-and-memory]] reports the same shape for annotation.',
      '',
      '## Open question',
      '',
      'Nobody has run this on reading a research literature, where the material is not a list',
      'of facts and the test is whether you can write something.',
      '',
    ].join('\n'),
  },
  {
    slug: 'demo-note-taking-in-practice',
    title: 'What people do with a marked passage',
    quote: 'Almost nobody returns to a highlight; they return to the note they made from it.',
    markdown: [
      '# What people do with a marked passage',
      '',
      'Almost nobody returns to a highlight; they return to the note they made from it. The',
      'highlight is a bookmark for an act of writing that may or may not happen.',
      '',
      '## Implication',
      '',
      'A tool that makes the writing cheap should beat one that makes the marking cheap. See',
      '[[demo-attention-and-memory]].',
      '',
    ].join('\n'),
  },
  {
    slug: 'demo-graphs-of-reading',
    title: 'Reading as a graph, not a list',
    markdown: [
      '# Reading as a graph, not a list',
      '',
      'A reading list is an ordering imposed on something that is not ordered. What a person',
      'actually has after a year is a graph: papers, the sentences they marked in them, and',
      'the connections they drew.',
      '',
      '## Why the shape matters',
      '',
      'Finding your way back to a passage is a navigation problem, and navigation problems are',
      'solved with maps. [[demo-note-taking-in-practice]] is the other half of this.',
      '',
    ].join('\n'),
  },
  {
    slug: 'demo-formal-models',
    title: 'Formal models of forgetting',
    markdown: [
      '# Formal models of forgetting',
      '',
      'Retention is usually fitted as $R = e^{-t/S}$, where $S$ stands for the strength of a',
      'memory and does most of the explanatory work while being defined by the fit.',
      '',
      '## The identifiability problem',
      '',
      'Two schedules that differ only in spacing produce the same curve under most',
      'parameterisations, which makes [[demo-spacing-effects]] hard to adjudicate formally.',
      '',
    ].join('\n'),
  },
  {
    slug: 'demo-tools-and-friction',
    title: 'Friction is the whole of tool design',
    markdown: [
      '# Friction is the whole of tool design',
      '',
      'Every feature that costs a decision is paid for on every use. The interesting question',
      'about a research tool is not what it can do but what it asks you first.',
      '',
      '## Applied here',
      '',
      'Linking two papers used to ask what kind of link it was. Nobody knew, every time.',
      '',
    ].join('\n'),
  },
];

/** The days the demo journal is written on, counting back from whatever today is. */
const JOURNAL_DAYS: readonly { readonly daysAgo: number; readonly markdown: string }[] = [
  {
    daysAgo: 6,
    markdown: [
      'Read the annotation/recall paper properly. The effect is real but the population is',
      'wrong for us — undergraduates cramming, not people reading a literature.',
      '',
      'Next: find anything on spacing in professional reading.',
    ].join('\n'),
  },
  {
    daysAgo: 3,
    markdown: [
      'Spacing paper is better than I expected in the field results and useless in the',
      'discussion. Marked the sentence about intervals.',
      '',
      'Wrote the claim about writing beating marking. Not sure I believe it yet.',
    ].join('\n'),
  },
  {
    daysAgo: 0,
    markdown: [
      'Drew the map for the first time and the shape is obvious: everything hangs off the',
      'annotation paper, which is the one I trust least.',
    ].join('\n'),
  },
];

export class DemoLibrary {
  readonly #db: WikiReaderDatabase;
  readonly #root: string;
  readonly #importer: MarkdownCorpusImporter;
  readonly #indexer: SearchIndexer;
  readonly #available: boolean;
  readonly #logger: Logger | undefined;

  constructor(options: DemoLibraryOptions) {
    this.#db = options.db;
    this.#root = options.root;
    this.#indexer = options.indexer;
    this.#available = options.available;
    this.#logger = options.logger?.child('demo');
    // Its own importer over its own root, tagged with its own source. The notes folder's
    // importer is untouched: pointing that one at the demo folder would ingest the demo as the
    // researcher's notes and there would be nothing left to tell them apart by.
    this.#importer = new MarkdownCorpusImporter(options.db, {
      root: options.root,
      allowed: options.allowed,
      source: DEMO_SOURCE,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
  }

  get root(): string {
    return this.#root;
  }

  status(): DemoStatus {
    const documents = this.#documentIds().length;
    const notebooks = readSeed(this.#db).notebookIds.filter(
      (id) => this.#db.questions.get(id) !== null,
    ).length;
    return {
      available: this.#available,
      filled: documents > 0 || notebooks > 0,
      documents,
      notebooks,
    };
  }

  /**
   * Put demo content on every surface.
   *
   * Idempotent by construction rather than by a guard: the importer skips a file whose bytes
   * are unchanged, the highlights and edges are looked up before they are made, and the
   * notebooks are only created when the ones already remembered have gone. Running it twice is
   * a no-op, which matters because the natural way to find out what it does is to press it.
   */
  async fill(): Promise<DemoSummary> {
    if (!this.#available) throw new DemoUnavailableError();

    await this.#writePapers();
    const imported = await this.#importer.import();
    this.#logger?.info('demo papers ingested', {
      created: imported.documentsCreated,
      updated: imported.documentsUpdated,
    });

    const bySlug = new Map<string, string>();
    for (const id of this.#documentIds()) {
      const slug = this.#db.documents.getById(id)?.slug;
      if (slug !== null && slug !== undefined) bySlug.set(slug, id);
    }

    const highlights = await this.#markSentences(bySlug);
    const links = this.#drawLinks(bySlug, highlights);
    const notes = this.#writeNote(bySlug);
    const { notebooks, journalDays } = this.#openNotebooks(bySlug, highlights);

    const summary: DemoSummary = {
      documents: bySlug.size,
      notebooks,
      highlights: highlights.size,
      links,
      journalDays,
      notes,
    };
    this.#logger?.info('demo library filled', { ...summary });
    return summary;
  }

  /**
   * Take all of it away again — the one action the criterion asks for.
   *
   * What goes: every document tagged `DEMO_SOURCE` with its highlights, every notebook the
   * demo opened with its journal, claims and references, the demo's note, and every edge with
   * one of those at an end. What stays: everything else, which is the assertion worth making
   * twice — a researcher who filled a real library with demo content to look at a panel must
   * get their own library back exactly as it was.
   */
  clear(): DemoSummary {
    if (!this.#available) throw new DemoUnavailableError();

    const seed = readSeed(this.#db);
    const documentIds = this.#documentIds();

    const summary = this.#db.transaction((): DemoSummary => {
      let highlights = 0;
      let links = 0;
      let journalDays = 0;
      let notebooks = 0;
      let notes = 0;

      for (const notebookId of seed.notebookIds) {
        if (this.#db.questions.get(notebookId) === null) continue;
        const removed = this.#db.questions.delete(notebookId);
        journalDays += removed.journalDays;
        links += removed.links;
        notebooks += 1;
      }

      for (const noteId of seed.noteIds) {
        links += this.#db.links.deleteForEntity('note', noteId);
        // A note is indexed under its own entity type with no `document_id`, so nothing that
        // sweeps a document reaches it. `search_entries` has no foreign key to `notes`.
        this.#db.searchIndex.remove('note', noteId);
        if (this.#db.notes.purge(noteId)) notes += 1;
      }

      for (const documentId of documentIds) {
        // One method rather than a list of steps written out here: the order matters (the
        // annotations' edges before the document that cascades them away) and so does the
        // membership — the search entries went unremoved for as long as this loop had its own
        // copy, and there is no reindex channel to take them out afterwards.
        const gone = this.#db.library.purge(documentId);
        links += gone.links;
        highlights += gone.annotations;
      }

      this.#db.settings.set(DEMO_SEED_SETTING, { notebookIds: [], noteIds: [] });
      return { documents: documentIds.length, notebooks, highlights, links, journalDays, notes };
    });

    this.#logger?.info('demo library cleared', { ...summary });
    return summary;
  }

  /** Every document this library owns, deleted ones included. One predicate, one answer. */
  #documentIds(): string[] {
    const found: string[] = [];
    const pageSize = 200;
    for (let offset = 0; ; offset += pageSize) {
      const { items } = this.#db.documents.list({
        source: DEMO_SOURCE,
        includeDeleted: true,
        limit: pageSize,
        offset,
      });
      for (const document of items) found.push(document.id);
      if (items.length < pageSize) break;
    }
    return found;
  }

  async #writePapers(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    for (const paper of PAPERS) {
      await writeFile(join(this.#root, `${paper.slug}.md`), paper.markdown, 'utf8');
    }
  }

  /**
   * Mark the sentence each paper was written around.
   *
   * A real anchor, built by `createMarkdownAnchor` over the file's own text, so a demo
   * highlight resolves in the reader exactly as one the researcher made would. An anchor
   * hand-written with made-up offsets would paint nowhere and the reader would look broken.
   */
  async #markSentences(bySlug: ReadonlyMap<string, string>): Promise<Map<string, string>> {
    const marks = new Map<string, string>();
    for (const paper of PAPERS) {
      const quote = paper.quote;
      const documentId = bySlug.get(paper.slug);
      if (quote === undefined || documentId === undefined) continue;

      const existing = this.#db.annotations
        .listByDocument(documentId)
        .find((annotation) => annotation.selectedText === quote);
      if (existing !== undefined) {
        marks.set(paper.slug, existing.id);
        continue;
      }

      const start = paper.markdown.indexOf(quote.slice(0, 40));
      const annotation = this.#db.annotations.create({
        documentId,
        kind: 'highlight',
        color: 'ochre',
        selectedText: quote,
        anchor: createMarkdownAnchor({
          selection: {
            kind: 'markdown',
            documentText: paper.markdown,
            text: quote,
            position: { start: Math.max(start, 0), end: Math.max(start, 0) + quote.length },
          },
          sourceHash: createHash('sha256').update(paper.markdown, 'utf8').digest('hex'),
        }),
      });
      // Indexed at once, the way a highlight the researcher just made is: a demo library whose
      // marked sentences cannot be searched would not fill the surface it is meant to fill.
      this.#indexer.indexAnnotation(annotation.id);
      marks.set(paper.slug, annotation.id);
    }
    return marks;
  }

  /**
   * The connections a person would have drawn by hand.
   *
   * The wikilinks between the papers are already edges by the time this runs — the importer
   * made them — so what is added here is the kind of edge only a reader makes: a marked
   * sentence in one paper joined to another paper it bears on.
   */
  #drawLinks(
    bySlug: ReadonlyMap<string, string>,
    marks: ReadonlyMap<string, string>,
  ): number {
    const wanted: { annotation: string; document: string }[] = [
      { annotation: 'demo-attention-and-memory', document: 'demo-spacing-effects' },
      { annotation: 'demo-note-taking-in-practice', document: 'demo-graphs-of-reading' },
      { annotation: 'demo-spacing-effects', document: 'demo-formal-models' },
    ];

    let created = 0;
    for (const entry of wanted) {
      const sourceId = marks.get(entry.annotation);
      const targetId = bySlug.get(entry.document);
      if (sourceId === undefined || targetId === undefined) continue;
      const already = this.#db.links
        .findReferences({ entityType: 'annotation', entityId: sourceId })
        .some((link) => link.targetId === targetId && link.type === 'related-to');
      if (already) continue;
      this.#db.links.create({
        type: 'related-to',
        sourceType: 'annotation',
        sourceId,
        targetType: 'document',
        targetId,
        origin: 'manual',
      });
      created += 1;
    }
    return created;
  }

  /** One note, of the kind made from a paper and linked to it in the same motion. */
  #writeNote(bySlug: ReadonlyMap<string, string>): number {
    const seed = readSeed(this.#db);
    if (seed.noteIds.some((id) => this.#db.notes.get(id) !== null)) return 0;

    const about = bySlug.get('demo-graphs-of-reading');
    const text =
      'The map is the argument. If the shape of what I have read is obvious at a glance, ' +
      'the gaps in it are obvious too — which is the only reason to draw one.';
    const note = this.#db.notes.create({
      title: 'Why a map at all',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
      contentText: text,
    });
    if (about !== undefined) {
      this.#db.links.create({
        type: 'note-about-document',
        sourceType: 'note',
        sourceId: note.id,
        targetType: 'document',
        targetId: about,
        origin: 'manual',
      });
    }
    this.#db.settings.set(DEMO_SEED_SETTING, {
      notebookIds: seed.notebookIds,
      noteIds: [...seed.noteIds, note.id],
    });
    return 1;
  }

  /**
   * Two lines of work and one that was set aside, with everything a notebook has.
   *
   * A page with prose on it, claims with evidence for and against, references to the papers
   * they were built from, and a journal with a few days in it — because "fills every surface"
   * means the notebook page, the claims strip, the calendar and the discarded shelf, not only
   * the library list.
   */
  #openNotebooks(
    bySlug: ReadonlyMap<string, string>,
    marks: ReadonlyMap<string, string>,
  ): { notebooks: number; journalDays: number } {
    const seed = readSeed(this.#db);
    const alive = seed.notebookIds.filter((id) => this.#db.questions.get(id) !== null);
    if (alive.length > 0) return { notebooks: 0, journalDays: 0 };

    const working = this.#db.questions.create({
      title: 'Does marking a sentence do anything a note would not?',
      status: 'active',
      importance: 4,
      nextAction: 'Find one study on professional reading rather than exam revision.',
    });
    this.#db.questions.update(working.id, {
      description:
        'Every tool in this space assumes highlighting is useful. The evidence is about exam revision, which is not what a research literature is read for.',
      tags: ['reading', 'memory', 'tools'],
    });
    this.#db.questions.writeBody(
      working.id,
      [
        '## The question',
        '',
        'Marking is cheap and writing is expensive, so every reading tool optimises marking.',
        'If the recall effect is really about the writing that follows a mark, that ordering',
        'is backwards.',
        '',
        '## What I have',
        '',
        'Two field results and one observation about behaviour. None of them are on the',
        'population I care about.',
        '',
        '## Method',
        '',
        'Read the three papers below properly, then write the objection out and see whether it',
        'survives being written down.',
        '',
      ].join('\n'),
    );

    const forClaim = this.#db.hypotheses.create({
      questionId: working.id,
      statement: 'The recall effect comes from the writing a mark provokes, not from the mark.',
    });
    this.#db.hypotheses.create({
      questionId: working.id,
      statement: 'Spacing matters more than anything a reading tool can change.',
      status: 'open',
    });

    let links = 0;
    const evidence: { slug: string; type: string }[] = [
      { slug: 'demo-note-taking-in-practice', type: 'annotation-supports-hypothesis' },
      { slug: 'demo-attention-and-memory', type: 'annotation-opposes-hypothesis' },
    ];
    for (const entry of evidence) {
      const annotationId = marks.get(entry.slug);
      if (annotationId === undefined) continue;
      this.#db.links.create({
        type: entry.type,
        sourceType: 'annotation',
        sourceId: annotationId,
        targetType: 'hypothesis',
        targetId: forClaim.id,
        origin: 'manual',
      });
      links += 1;
    }

    for (const slug of ['demo-attention-and-memory', 'demo-spacing-effects']) {
      const documentId = bySlug.get(slug);
      if (documentId === undefined) continue;
      this.#db.links.create({
        type: 'question-references-document',
        sourceType: 'question',
        sourceId: working.id,
        targetType: 'document',
        targetId: documentId,
        origin: 'manual',
      });
      links += 1;
    }

    const today = new Date();
    const start = new Date(today.getTime() - 13 * 24 * 60 * 60 * 1000);
    this.#db.questions.update(working.id, { journalStart: isoDay(start) });
    let journalDays = 0;
    for (const day of JOURNAL_DAYS) {
      const when = new Date(today.getTime() - day.daysAgo * 24 * 60 * 60 * 1000);
      this.#db.journal.write(working.id, isoDay(when), day.markdown);
      journalDays += 1;
    }

    const second = this.#db.questions.create({
      title: 'What is the smallest thing that makes a graph worth opening?',
      status: 'queued',
      importance: 2,
    });
    this.#db.questions.writeBody(
      second.id,
      [
        '## The question',
        '',
        'A graph of forty identical discs is a picture of nothing. What is the least that has',
        'to be true of a node before the map is worth looking at?',
        '',
      ].join('\n'),
    );

    const abandoned = this.#db.questions.create({
      title: 'Can a reading tool infer what you are working on?',
      status: 'active',
    });
    this.#db.questions.discard(
      abandoned.id,
      'Every version of this turned into guessing, and a wrong guess costs more than no guess.',
    );

    const notebookIds = [working.id, second.id, abandoned.id];
    this.#db.settings.set(DEMO_SEED_SETTING, {
      notebookIds,
      noteIds: readSeed(this.#db).noteIds,
    });
    this.#logger?.info('demo notebooks opened', { notebooks: notebookIds.length, links });
    return { notebooks: notebookIds.length, journalDays };
  }
}

function isoDay(when: Date): string {
  return when.toISOString().slice(0, 10);
}

/** Where the demo's markdown lives when nothing says otherwise: beside the database. */
export function defaultDemoRoot(databasePath: string): string {
  if (isAbsolute(databasePath)) return join(dirname(databasePath), 'demo');
  return join(tmpdir(), 'wiki-reader', 'demo');
}
