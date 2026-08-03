/**
 * IPC handler implementations.
 *
 * One function per channel in `IPC_CHANNELS`. This module imports no Electron API on
 * purpose: `router.ts` supplies the transport, and the handlers themselves are ordinary
 * functions over `AppServices`. The persistence criteria are then testable end-to-end
 * against a real database instead of against a mock of one.
 *
 * Handlers receive requests that the router has already parsed with the channel's zod
 * schema, so defaults are applied and the input shape is guaranteed here.
 */
import { readFile } from 'node:fs/promises';
import type { AgentRunRecord, StoredProposal } from '@wr/database';
import { toDocumentFileRef, type WikiReaderDatabase } from '@wr/database';
import {
  blankNotebook,
  blankNotebookTypst,
  documentReferenceMarkdown,
  documentReferenceTypst,
  excerptMarkdown,
  excerptTypst,
  extractHtmlText,
  imageTypst,
  NOTEBOOK_TEMPLATE_SECTIONS,
  type NotebookBodyFormat,
} from '@wr/document-model';
import {
  AgentProposalIdSchema,
  AgentRunIdSchema,
  DocumentFileIdSchema,
  DocumentIdSchema,
  journalEntityId,
  JournalDateSchema,
  parseJournalEntityId,
  ProposalCitationSchema,
  QuestionIdSchema,
  unlinkRefusal,
  type AgentProposal,
  type AgentRunSummary,
  type DocumentLocation,
  type IpcChannel,
  type IpcError,
  type IpcRequestParsed,
  type IpcResponse,
  type LinkableEntityType,
  type NotebookPage,
} from '@wr/shared-types';
import { appendNotebookBlocks } from './notebook-body.js';
import { typstService } from './typst.js';
import { DemoUnavailableError } from './demo.js';
import { agentProgress, type AppServices } from './services.js';
import {
  agentDisclosure,
  DisclosureNotAcknowledgedError,
  readAgentSettings,
  setAgentsEnabled,
  writeAgentSettings,
} from './agents/settings.js';
import {
  collectionOptions,
  collectionOptionsFromLibrary,
  readImportScope,
  writeImportScope,
} from './import-scope.js';
import {
  cardArtDisclosure,
  cardArtStatus,
  CARD_ART_SET_NAME,
  CardArtDisabledError,
  CardArtDisclosureNotAcknowledgedError,
  CardArtRefusedError,
  setCardArtEnabled,
} from './card-art.js';
import { resolveAllowedPath } from './paths.js';

/** A failure that the router turns into a structured `IpcError` instead of a stack trace. */
export class HandlerError extends Error {
  constructor(
    readonly code: IpcError['code'],
    message: string,
    readonly details?: Record<string, unknown>,
    readonly remedy?: string,
  ) {
    super(message);
    this.name = 'HandlerError';
  }
}

const notFound = (what: string, id: string): HandlerError =>
  new HandlerError('NOT_FOUND', `${what} not found`, { id });

/**
 * A refusal from the demo library, said the way the renderer can show it (`B07`).
 *
 * `CONFLICT` rather than an invalid request: nothing is wrong with the ask, this build simply
 * is not one where demo content exists. Anything else that went wrong stays what it was.
 */
function demoFailure(error: unknown): unknown {
  if (error instanceof DemoUnavailableError) {
    return new HandlerError(
      'CONFLICT',
      error.message,
      {},
      'Demo content exists only while the app is being developed. A packaged build has none.',
    );
  }
  return error;
}

/**
 * Which files a link is news for.
 *
 * An endpoint is either a document, or something that belongs to one — the resolver already
 * knows which, and knows it for every entity type rather than for the two anyone remembers.
 * Named here so a view listening for "did anything about this paper change" hears about an
 * edge made on one of its highlights too.
 */
function documentsTouchedBy(
  db: WikiReaderDatabase,
  link: { sourceType: LinkableEntityType; sourceId: string; targetType: LinkableEntityType; targetId: string },
): ReturnType<typeof DocumentIdSchema.parse>[] {
  const ids = new Set<string>();
  for (const [type, id] of [
    [link.sourceType, link.sourceId],
    [link.targetType, link.targetId],
  ] as const) {
    if (type === 'document') ids.add(id);
    const described = db.entities.describe(type, id);
    if (described?.documentId != null) ids.add(described.documentId);
  }
  return [...ids].flatMap((id) => {
    const parsed = DocumentIdSchema.safeParse(id);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Which notebooks a link is news for.
 *
 * A notebook page draws two things out of `links`: the *For* and *Against* lines under each
 * of its claims. Both can be written from somewhere else in the
 * workspace — the researcher marks the sentence that settles a claim in the reader beside the
 * page and links it there (`E02`), and the librarian proposes evidence without a page being
 * open at all — so a page that hears only about its own calls is a page whose *For* line stays
 * empty until it is remounted. A claim's notebook is its `questionId`; a day's is in its
 * endpoint id.
 */
function notebooksTouchedBy(
  db: WikiReaderDatabase,
  link: { sourceType: LinkableEntityType; sourceId: string; targetType: LinkableEntityType; targetId: string },
): ReturnType<typeof QuestionIdSchema.parse>[] {
  const ids = new Set<string>();
  for (const [type, id] of [
    [link.sourceType, link.sourceId],
    [link.targetType, link.targetId],
  ] as const) {
    if (type === 'question') ids.add(id);
    if (type === 'hypothesis') {
      const hypothesis = db.hypotheses.get(id);
      if (hypothesis !== null) ids.add(hypothesis.questionId);
    }
    if (type === 'journal') {
      const day = parseJournalEntityId(id);
      if (day !== null) ids.add(day.notebookId);
    }
  }
  return [...ids].flatMap((id) => {
    const parsed = QuestionIdSchema.safeParse(id);
    return parsed.success ? [parsed.data] : [];
  });
}

/** What a dropped picture becomes in a day's markdown. Extensions the reader can draw. */
const PICTURE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

/** Whether a dropped file is a figure. Anything else is a paper, and lands as a reference. */
const isPicture = (path: string): boolean =>
  PICTURE_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension));

/**
 * A picture dropped on a day's entry (criterion P04).
 *
 * The image is added to the library where it lies — nothing is copied — and then *appended to
 * the day's markdown as a block*, here, because the markdown is held in this process and the
 * page is a view over it. The reference is `rrfile://<file id>`, which is the only kind of
 * image reference the renderer can be given: the id resolves through `document_files` in the
 * protocol handler, which checks the path against the allowed roots before it streams a byte.
 * A path never crosses to the renderer, and no copy of the picture is made anywhere.
 */
/**
 * The pictures among a drop, as markdown image blocks.
 *
 * Shared by the two surfaces that take one — a day and a page — because what a figure *is* in
 * markdown must not be two answers. The title is the alt text: a figure with no description is
 * one nobody can find again, and the file's own name is the only description anybody has
 * supplied yet.
 */
async function picturesAsBlocks(
  services: AppServices,
  paths: readonly string[],
  // The surface's language (`S06`). A journal day is markdown and a Typst notebook is Typst,
  // and the picture is the same file either way: the drop path does not change, only the
  // sentence that gets written. `#image("/img/<file id>")` is the Typst side of `rrfile://` —
  // the compiler is handed the bytes under that name in the main process, so neither spelling
  // ever puts a filesystem path anywhere a renderer could see one.
  format: NotebookBodyFormat = 'markdown',
): Promise<{ readonly blocks: string[]; readonly documentIds: string[] }> {
  const pictures = paths.filter(isPicture);
  const { documents } = await services.localFiles.addMany(pictures);
  const blocks: string[] = [];
  const documentIds: string[] = [];
  for (const document of documents) {
    const file = services.db.files.primaryForDocument(document.id);
    if (file === null) continue;
    documentIds.push(document.id);
    blocks.push(
      format === 'typst'
        ? imageTypst({ fileId: file.id, alt: document.title })
        : `![${document.title}](rrfile://${file.id})`,
    );
  }
  return { blocks, documentIds };
}

async function receivePictures(
  services: AppServices,
  day: { readonly notebookId: string; readonly date: string },
  paths: readonly string[],
): Promise<{ readonly added: number }> {
  const { db } = services;
  if (db.questions.get(day.notebookId) === null) throw notFound('notebook', day.notebookId);

  const { blocks, documentIds } = await picturesAsBlocks(services, paths);

  if (blocks.length > 0) {
    const existing = db.journal.get(day.notebookId, day.date)?.markdown ?? '';
    const joined = existing === '' ? blocks.join('\n\n') : `${existing}\n\n${blocks.join('\n\n')}`;
    db.journal.write(day.notebookId, day.date, joined);
    services.publish('library:changed', {
      reason: 'import',
      documentIds: documentIds.map((id) => DocumentIdSchema.parse(id)),
    });
  }

  // Published even when nothing was added: the page asked for a drop and is entitled to know
  // what came of it, and `added: 0` is an answer rather than silence.
  services.publish('journal:changed', {
    notebookId: QuestionIdSchema.parse(day.notebookId),
    date: JournalDateSchema.parse(day.date),
    reason: 'drop',
    added: blocks.length,
  });
  return { added: blocks.length };
}

/**
 * What a thing sent to a notebook reads as on its page (`P06`, `E01`).
 *
 * A highlight lands as the sentence it marks and a paper lands as its name, and both carry the
 * internal link that carries the researcher back — which is the whole difference between a
 * reference and a copied title. `null` when the other end has gone between the edge being made
 * and this being asked, which the caller treats as "the edge, and no block".
 */
function notebookLandingBlock(
  db: WikiReaderDatabase,
  targetType: 'document' | 'annotation',
  targetId: string,
  format: NotebookBodyFormat,
): string | null {
  if (targetType === 'document') {
    const document = db.documents.getById(targetId);
    if (document === null) return null;
    const reference = { documentId: document.id, title: document.title };
    return format === 'typst'
      ? documentReferenceTypst(reference)
      : documentReferenceMarkdown(reference);
  }
  const annotation = db.annotations.get(targetId);
  if (annotation === null) return null;
  const source = db.documents.getById(annotation.documentId);
  const excerpt = {
    annotationId: annotation.id,
    selectedText: annotation.selectedText,
    sourceTitle: source?.title ?? '',
  };
  return format === 'typst' ? excerptTypst(excerpt) : excerptMarkdown(excerpt);
}

/**
 * Anything dropped on a notebook's page (`P06`, `S01`).
 *
 * One target where there used to be two. A picture becomes a figure and a paper becomes a
 * reference, and both are *blocks appended to `questions.body`* — written here because that
 * markdown is held in this process and the page is only a view over it. Where the desk board
 * used to catch a dropped paper and draw a card, the page catches it and grows a line the
 * researcher can write around; the `question-references-document` edge is still made, because
 * the edge is what the graph, the ledger and the references panel read, and it was never the
 * card that carried the relationship.
 *
 * Nothing is copied, either way. An image is referenced as `rrfile://<file id>` and a paper as
 * `document://<id>`; neither is a path, and a path is the one thing the renderer must never be
 * handed.
 */
async function receivePageDrop(
  services: AppServices,
  questionId: string,
  paths: readonly string[],
): Promise<{ readonly added: number }> {
  const { db } = services;
  if (db.questions.get(questionId) === null) throw notFound('notebook', questionId);

  const format = db.questions.readBodyFormat(questionId);
  const { blocks, documentIds } = await picturesAsBlocks(services, paths, format);
  const papers = paths.filter((path) => !isPicture(path));
  let extractable = false;
  if (papers.length > 0) {
    // Already referred to by this page. Dropping the same paper twice is one reference: the
    // library row is idempotent by path, and this keeps the notebook from growing a second
    // edge to the same document.
    const referenced = new Set(
      db.links
        // Unbounded on purpose: this set is a *predicate* — "does this page already refer to
        // that paper" — and a page of the oldest 500 answers "no" for everything past the cap,
        // so a paper dropped on a busy notebook a second time would grow a second edge.
        .findReferences({
          entityType: 'question',
          entityId: questionId,
          direction: 'outgoing',
          limit: null,
        })
        .filter((link) => link.type === 'question-references-document')
        .map((link) => link.targetId),
    );
    // One bad file among them — a folder, something unreadable — is skipped and logged inside
    // `addMany`, never with the path in the message.
    const { documents } = await services.localFiles.addMany(papers);
    for (const document of documents) {
      documentIds.push(document.id);
      extractable = true;
      if (referenced.has(document.id)) continue;
      db.links.create({
        type: 'question-references-document',
        sourceType: 'question',
        sourceId: questionId,
        targetType: 'document',
        targetId: document.id,
        origin: 'manual',
      });
      referenced.add(document.id);
      const reference = { documentId: document.id, title: document.title };
      blocks.push(
        format === 'typst'
          ? documentReferenceTypst(reference)
          : documentReferenceMarkdown(reference),
      );
    }
  }

  const added = appendNotebookBlocks(db, questionId, blocks);
  if (documentIds.length > 0) {
    if (extractable) {
      void services.pipeline.drain().catch((error: unknown) => {
        services.logger.error('pipeline drain failed after a drop', { error });
      });
    }
    services.publish('library:changed', {
      reason: 'import',
      documentIds: documentIds.map((id) => DocumentIdSchema.parse(id)),
    });
  }

  // Published even when nothing was added: the page asked for a drop and is entitled to know
  // what came of it, and `added: 0` is an answer rather than silence.
  services.publish('notebook:changed', {
    questionId: QuestionIdSchema.parse(questionId),
    reason: 'drop',
    added,
  });
  return { added };
}

/**
 * Files dropped on a notebook's page (criteria N07, P06, S01), on the library (B02), or on a
 * day's entry (P04).
 *
 * Not one of the channels below, on purpose: this is reached over `wr:drop`, which the
 * preload can send and the renderer cannot. It is here because what a request *does* belongs
 * with the other request handlers, and because everything it touches — the library, the
 * links, the publish — is the same machinery they use.
 *
 * Each file is added where it lies. On the library it is related to nothing, because it is not
 * about anything yet.
 */
export async function receiveDrop(
  services: AppServices,
  request: {
    readonly journalDay?: { readonly notebookId: string; readonly date: string } | null;
    readonly notebookPage?: string | null;
    readonly paths: readonly string[];
  },
): Promise<{ readonly added: number }> {
  const day = request.journalDay ?? null;
  if (day !== null) return receivePictures(services, day, request.paths);
  const notebookPage = request.notebookPage ?? null;
  if (notebookPage !== null) return receivePageDrop(services, notebookPage, request.paths);

  // One bad file among them — a folder, something unreadable — is skipped and logged inside
  // `addMany`, never with the path in the message.
  const { documents } = await services.localFiles.addMany(request.paths);
  const documentIds = documents.map((document) => document.id);
  if (documentIds.length > 0) {
    void services.pipeline.drain().catch((error: unknown) => {
      services.logger.error('pipeline drain failed after a drop', { error });
    });
    services.publish('library:changed', {
      reason: 'import',
      documentIds: documentIds.map((id) => DocumentIdSchema.parse(id)),
    });
  }
  return { added: documentIds.length };
}

export type Handlers = {
  [K in IpcChannel]: (request: IpcRequestParsed<K>) => Promise<IpcResponse<K>> | IpcResponse<K>;
};

/**
 * A highlight belongs to the revision that was on screen when it was made, so that a later
 * re-extraction can tell "anchored against these bytes" from "anchored against older bytes".
 */
function currentRevisionId(db: WikiReaderDatabase, documentId: string): string | null {
  const file = db.files.primaryForDocument(documentId);
  if (file?.revisionId != null) return file.revisionId;
  return db.revisions.latestForDocument(documentId)?.id ?? null;
}

function locationLabel(location: DocumentLocation | null): string {
  if (location === null) return '';
  switch (location.kind) {
    case 'pdf':
      return `p. ${String(location.pageIndex + 1)}`;
    case 'html':
      return location.sectionPath ?? '';
    case 'markdown':
      return location.headingPath ?? '';
    case 'note':
      return location.blockIndex === undefined ? '' : `block ${String(location.blockIndex + 1)}`;
  }
}

/**
 * The whole page behind a question: front matter, prose, and claims with their evidence.
 *
 * The evidence is read back through the same reference query the references panel and the
 * graph use, so a citation arrives *resolved* — the highlight's own words and the location
 * that opens them — and a citation whose other end has gone is marked broken rather than
 * quietly dropped. Storing ids and handing them back would look identical from the channel
 * and be useless on the page.
 *
 * An unwritten page reads as the section template. It is not stored: `body` stays empty in
 * the row until the researcher types, so the template is what a blank page looks like rather
 * than something the app wrote on their behalf.
 */
function notebookPage(db: WikiReaderDatabase, questionId: string): NotebookPage {
  const question = db.questions.get(questionId);
  if (question === null) throw notFound('notebook', questionId);
  const body = db.questions.readBody(questionId) ?? '';
  const hypotheses = db.hypotheses.listForQuestion(questionId).map((hypothesis) => {
    const cited = db.links.findReferences({
      entityType: 'hypothesis',
      entityId: hypothesis.id,
      direction: 'incoming',
    });
    return {
      ...hypothesis,
      supporting: cited.filter((link) => link.type.endsWith('-supports-hypothesis')),
      opposing: cited.filter((link) => link.type.endsWith('-opposes-hypothesis')),
    };
  });
  // The language this page is written in, and the template that matches it (`S04`). A page
  // from before the switch answers `markdown` and gets the markdown template, which is what
  // makes "nothing already written is lost" a fact about the column rather than a hope.
  const bodyFormat = db.questions.readBodyFormat(questionId);
  const blank =
    bodyFormat === 'typst' ? blankNotebookTypst(NOTEBOOK_TEMPLATE_SECTIONS) : blankNotebook();
  return {
    question,
    body: body === '' ? blank : body,
    bodyFormat,
    typstHeader: db.questions.readTypstHeader(questionId),
    hypotheses,
  };
}

/**
 * A run, reduced to what an interface shows about it.
 *
 * Not the transcript: what a person wants from a finished pass is whether it worked, when,
 * and how much it produced. The rest is in the log, where a diagnosis belongs.
 */
function toRunSummary(run: AgentRunRecord): AgentRunSummary {
  return {
    id: AgentRunIdSchema.parse(run.id),
    status: run.status,
    trigger: run.trigger,
    proposalCount: run.proposalCount,
    summary: run.summary,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

/**
 * A stored proposal, on its way to the renderer.
 *
 * Citations are re-parsed rather than cast. They were resolved against the database before
 * the row was written, so a citation that fails here is a corrupted row and not a citation
 * the agent got wrong — and a proposal listing an entity that cannot be opened is exactly
 * what `A04` exists to prevent, so it fails loudly instead of arriving half-formed.
 */
function toAgentProposal(stored: StoredProposal): AgentProposal {
  return {
    id: AgentProposalIdSchema.parse(stored.id),
    runId: AgentRunIdSchema.parse(stored.runId),
    kind: stored.kind,
    title: stored.title,
    body: stored.body,
    status: stored.status,
    citations: stored.citations.map((citation) => ProposalCitationSchema.parse(citation)),
    covers: stored.covers.map((citation) => ProposalCitationSchema.parse(citation)),
    documentId: stored.documentId === null ? null : DocumentIdSchema.parse(stored.documentId),
    createdAt: stored.createdAt,
    decidedAt: stored.decidedAt,
  };
}

export function createHandlers(services: AppServices): Handlers {
  const { db, logger } = services;

  /** Whether the librarian may run, and what the last pass left behind. Starts nothing. */
  const agentStatus = (): IpcResponse<'agent:status'> => {
    const settings = readAgentSettings(db);
    const lastRun = db.agentRuns.latest();
    return {
      enabled: settings.enabled,
      capabilities: [...settings.capabilities],
      disclosureAcknowledged: settings.disclosureAcknowledgedAt !== null,
      running: services.agents.runner.busy,
      pendingProposals: db.agentRuns.listProposals({ status: 'pending' }).items.length,
      lastRun: lastRun === null ? null : toRunSummary(lastRun),
    };
  };

  /**
   * Say that an edge was written or removed, to everyone who draws one.
   *
   * `library:changed` is for the drawings of the whole table — the ledger, the wiki page, the
   * focused view. `notebook:changed` is for the page that draws *this* edge as part of itself:
   * a card on the desk, or the *For* / *Against* line under a claim. The second used to be
   * missing, so `E02`'s gesture — mark the sentence in the reader, link it to the claim in the
   * notebook open beside it — left the *For* line empty until the panel was remounted.
   */
  const announceLink = (link: {
    sourceType: LinkableEntityType;
    sourceId: string;
    targetType: LinkableEntityType;
    targetId: string;
  }): void => {
    services.publish('library:changed', {
      reason: 'link',
      documentIds: documentsTouchedBy(db, link),
    });
    for (const questionId of notebooksTouchedBy(db, link)) {
      services.publish('notebook:changed', { questionId, reason: 'link', added: 0 });
    }
  };

  /** Fire-and-forget queue drain: the caller gets its response without waiting for PDFs. */
  const kickPipeline = (): void => {
    void services.pipeline.drain().catch((error: unknown) => {
      logger.error('pipeline drain failed', { error });
    });
  };

  return {
    // --- Zotero -----------------------------------------------------------
    'zotero:probe': async () => {
      const probe = await services.zotero.probe();
      logger.info('zotero probed', {
        running: probe.running,
        localApiEnabled: probe.localApiEnabled,
      });
      return probe;
    },

    'zotero:listCollections': async () => {
      try {
        const live = await services.zotero.listCollections();
        return {
          collections: collectionOptions(live),
          live: true,
          message: '',
        };
      } catch (error) {
        // Zotero being closed is the ordinary case, not an error worth failing the channel
        // over: the picker falls back to what the last import mirrored and says so.
        const fallback = collectionOptionsFromLibrary(db);
        // Careful with this message: electron-vite's CommonJS shim is placed after the last
        // thing in the *bundle* that matches its static-import regex, and a log string ending
        // in the bare word `import` followed by another string literal matches it. The shim
        // then lands in the middle of that literal and the build fails with an unterminated
        // string a long way from the cause.
        logger.info('zotero collections unavailable; falling back to the library', {
          error: String(error),
          collections: fallback.length,
        });
        return {
          collections: fallback,
          live: false,
          message:
            fallback.length === 0
              ? 'Zotero is not running, and nothing has been imported yet.'
              : 'Zotero is not running — these are the collections from the last import.',
        };
      }
    },

    'zotero:getImportScope': () => ({ collections: [...readImportScope(db)] }),

    'zotero:setImportScope': ({ collections }) => ({
      collections: [...writeImportScope(db, collections)],
    }),

    'zotero:import': async ({ force, collection, collections }) => {
      // Absent, not empty, falls back to the remembered picks: an explicit empty list is how
      // the interface says "the whole library" after unticking everything.
      const explicit = collections ?? (collection === undefined ? undefined : [collection]);
      const scope = explicit ?? readImportScope(db);
      // Which of the two this is decides whether removals are lifted, so it is passed rather
      // than inferred from `scope`: the remembered picks narrow the routine sync as well, and
      // a run that is merely filtered by them is not the researcher asking for a paper back.
      const summary = await services.importer.import({
        force,
        collections: scope,
        scopeOrigin: explicit === undefined ? 'remembered' : 'named',
      });
      logger.info('zotero import finished', {
        scope: summary.collectionScope ?? 'whole library',
        itemsSeen: summary.itemsSeen,
        created: summary.documentsCreated,
        updated: summary.documentsUpdated,
        filesLinked: summary.filesLinked,
        warnings: summary.warnings.length,
      });
      services.publish('library:changed', { reason: 'import', documentIds: [] });
      kickPipeline();
      return summary;
    },

    // --- Markdown corpus --------------------------------------------------
    'corpus:import': async ({ force }) => {
      const summary = await services.corpus.import({ force });
      logger.info('corpus import finished', {
        filesSeen: summary.filesSeen,
        created: summary.documentsCreated,
        updated: summary.documentsUpdated,
        links: summary.linksCreated,
        warnings: summary.warnings.length,
      });
      services.publish('library:changed', { reason: 'import', documentIds: [] });
      // The root itself stays in the main process: the response counts files, it does not
      // name where they are.
      const { root: _root, ...rest } = summary;
      return { ...rest, warnings: [...rest.warnings] };
    },

    'corpus:folder': () => services.notesFolder.status(),

    'corpus:chooseFolder': async () => {
      const change = await services.notesFolder.choose();
      if (change.changed) {
        logger.info('notes folder chosen', {
          purged: change.purged,
          created: change.documentsCreated,
        });
        services.publish('library:changed', { reason: 'import', documentIds: [] });
      }
      return change;
    },

    'corpus:wantedPages': ({ limit }) => ({
      pages: db.wantedPages.list(limit).map((page) => ({
        slug: page.slug,
        title: page.title,
        count: page.count,
        referencedBy: page.referencedBy.map((id) => DocumentIdSchema.parse(id)),
      })),
    }),

    // --- Library ----------------------------------------------------------
    'library:listDocuments': ({ collectionId, tag, query, source, limit, offset }) =>
      db.library.list({
        ...(collectionId === undefined ? {} : { collectionId }),
        ...(tag === undefined ? {} : { tag }),
        ...(query === undefined ? {} : { query }),
        ...(source === undefined ? {} : { source }),
        limit,
        offset,
      }),

    'library:getDocument': ({ documentId }) => {
      const item = db.library.get(documentId);
      if (item === null) throw notFound('document', documentId);
      return { item };
    },

    /**
     * Take a document out of the library (criteria B01, B03).
     *
     * The removal is recorded, never performed on Zotero: `~/Zotero/zotero.sqlite` is not
     * opened here or anywhere else. What the researcher made on the document — highlights,
     * comments, the edges tying it to a question — is left untouched and reported back, so the
     * interface can say what is still there rather than implying it was thrown away.
     *
     * The way back is `zotero:import` scoped to a collection holding it, which is why there is
     * no restore channel beside this one.
     */
    'library:removeDocument': ({ documentId }) => {
      if (db.documents.getById(documentId) === null) throw notFound('document', documentId);
      const removal = db.library.remove(documentId);
      logger.info('document removed from the library', {
        documentId,
        annotationsKept: removal.annotationsKept,
        linksKept: removal.linksKept,
        tombstones: removal.tombstones,
      });
      services.publish('library:changed', {
        reason: 'delete',
        documentIds: [DocumentIdSchema.parse(documentId)],
      });
      return {
        removed: removal.removed,
        annotationsKept: removal.annotationsKept,
        linksKept: removal.linksKept,
      };
    },

    /**
     * Add files from the disk (criterion B02).
     *
     * The dialog is opened by the main process and the paths never come back out: the
     * response counts what was added and names documents, which is all the renderer needs to
     * show them.
     */
    'library:addFiles': async () => {
      const result = await services.localFiles.addChosen();
      if (result.documents.length > 0) {
        services.publish('library:changed', {
          reason: 'import',
          documentIds: result.documents.map((document) => DocumentIdSchema.parse(document.id)),
        });
        kickPipeline();
      }
      logger.info('files added from disk', {
        chose: result.chose,
        added: result.documents.length,
        created: result.created,
        failed: result.failed,
      });
      return {
        chose: result.chose,
        added: result.documents.length,
        documentIds: result.documents.map((document) => DocumentIdSchema.parse(document.id)),
        failed: result.failed,
      };
    },

    'library:listCollections': () => ({ collections: db.collections.list() }),

    'library:listTags': () => ({ tags: db.tags.list() }),

    // --- Documents --------------------------------------------------------
    'document:openFile': ({ fileId }) => {
      const file = db.files.getById(fileId);
      if (file === null) throw notFound('file', fileId);
      const document = db.documents.getById(file.documentId);
      if (document === null) throw notFound('document', file.documentId);
      // `toDocumentFileRef` is what strips the filesystem path and substitutes rrfile://.
      return { file: toDocumentFileRef(file), document };
    },

    'document:getReadingPosition': ({ documentId }) => ({
      position: db.readingPositions.get(documentId),
    }),

    'document:setReadingPosition': ({ documentId, location }) => {
      if (db.documents.getById(documentId) === null) throw notFound('document', documentId);
      return { position: db.readingPositions.set(documentId, location) };
    },

    'document:getOutline': ({ documentId }) => {
      if (db.documents.getById(documentId) === null) throw notFound('document', documentId);
      // Embedded PDF bookmark outlines are post-milestone. The navigable structure that
      // actually exists after extraction is the page sequence, built from indexed chunks
      // rather than invented, so an un-extracted document correctly returns nothing.
      const outline = db.chunks
        .listForDocument(documentId)
        .filter((chunk) => chunk.kind === 'pdf-page' && chunk.pageIndex !== null)
        .map((chunk) => ({
          title: `p. ${String((chunk.pageIndex ?? 0) + 1)}`,
          level: 1,
          location: { kind: 'pdf' as const, pageIndex: chunk.pageIndex ?? 0 },
        }));
      return { outline };
    },

    'document:requestExtraction': ({ documentId }) => {
      if (db.documents.getById(documentId) === null) throw notFound('document', documentId);
      const queued = services.pipeline.enqueue(documentId);
      kickPipeline();
      return { queued };
    },

    /**
     * The words of an archived page, so the reader can anchor into them (`H01`).
     *
     * Read from the bytes on disk rather than from the indexed chunks: chunks are the search
     * index's shape and may not exist yet, and an anchor whose offsets came from a different
     * text than the one resolution recomputes is an anchor that lands nowhere. The path is
     * resolved through the allow-list first, exactly as `rrfile://` does — a row pointing
     * somewhere unexpected must not become a file read.
     */
    'document:getSnapshotText': async ({ documentId }) => {
      const document = db.documents.getById(documentId);
      if (document === null) throw notFound('document', documentId);
      const file = db.files.primaryForDocument(documentId);
      if (file === null) throw notFound('file', documentId);
      const resolved = await resolveAllowedPath(file.path, services.allowed);
      if (!resolved.ok) {
        logger.warn('refused snapshot text outside allowed roots', { documentId });
        throw notFound('file', file.id);
      }
      return {
        text: extractHtmlText(await readFile(resolved.path, 'utf8')),
        snapshotHash: file.contentHash,
      };
    },

    // --- Annotations ------------------------------------------------------
    'annotation:create': ({ documentId, kind, color, selectedText, comment, anchor }) => {
      if (db.documents.getById(documentId) === null) throw notFound('document', documentId);
      const annotation = db.annotations.create({
        documentId,
        revisionId: currentRevisionId(db, documentId),
        kind,
        color,
        selectedText,
        comment,
        anchor,
      });
      // Indexed immediately: a highlight the user just made must be findable at once.
      services.indexer.indexAnnotation(annotation.id);
      logger.info('annotation created', { annotationId: annotation.id, documentId, kind });
      services.publish('library:changed', {
        reason: 'annotation',
        documentIds: [DocumentIdSchema.parse(documentId)],
      });
      return { annotation };
    },

    'annotation:listByDocument': ({ documentId }) => ({
      annotations: db.annotations.listByDocument(documentId),
    }),

    'annotation:get': ({ annotationId }) => {
      const annotation = db.annotations.get(annotationId);
      if (annotation === null) throw notFound('annotation', annotationId);
      return { annotation };
    },

    'annotation:update': ({ annotationId, color, comment }) => {
      if (db.annotations.get(annotationId) === null) throw notFound('annotation', annotationId);
      const annotation = db.annotations.update(annotationId, {
        ...(color === undefined ? {} : { color }),
        ...(comment === undefined ? {} : { comment }),
      });
      services.indexer.indexAnnotation(annotation.id);
      return { annotation };
    },

    'annotation:delete': ({ annotationId }) => {
      const existing = db.annotations.get(annotationId);
      if (existing === null) throw notFound('annotation', annotationId);
      const deleted = db.annotations.softDelete(annotationId);
      db.searchIndex.remove('annotation', annotationId);
      logger.info('annotation deleted', { annotationId });
      services.publish('library:changed', {
        reason: 'delete',
        documentIds: [DocumentIdSchema.parse(existing.documentId)],
      });
      return { deleted };
    },

    // --- Notes ------------------------------------------------------------
    'note:create': ({ title, contentJson, contentText, attachToAnnotationId, attachToDocumentId }) => {
      // The note and its edges are one unit: a note that claims to be attached but has no
      // link would be unreachable from the annotation it was written against.
      const { note, links } = db.transaction(() => {
        const created = db.notes.create({ title, contentJson, contentText });
        const edges = [];

        if (attachToAnnotationId !== undefined) {
          if (db.annotations.get(attachToAnnotationId) === null) {
            throw notFound('annotation', attachToAnnotationId);
          }
          edges.push(
            db.links.create({
              type: 'note-references-annotation',
              sourceType: 'note',
              sourceId: created.id,
              targetType: 'annotation',
              targetId: attachToAnnotationId,
              origin: 'manual',
            }),
          );
        }

        if (attachToDocumentId !== undefined) {
          if (db.documents.getById(attachToDocumentId) === null) {
            throw notFound('document', attachToDocumentId);
          }
          edges.push(
            db.links.create({
              type: 'note-references-document',
              sourceType: 'note',
              sourceId: created.id,
              targetType: 'document',
              targetId: attachToDocumentId,
              origin: 'manual',
            }),
          );
        }

        return { note: created, links: edges };
      });

      services.indexer.indexNote(note.id);
      logger.info('note created', { noteId: note.id, links: links.length });
      services.publish('library:changed', { reason: 'note', documentIds: [] });
      return { note, links };
    },

    'note:get': ({ noteId }) => {
      const note = db.notes.get(noteId);
      if (note === null) throw notFound('note', noteId);
      return { note };
    },

    'note:update': ({ noteId, title, contentJson, contentText }) => {
      if (db.notes.get(noteId) === null) throw notFound('note', noteId);
      const note = db.notes.update(noteId, {
        ...(title === undefined ? {} : { title }),
        ...(contentJson === undefined ? {} : { contentJson }),
        ...(contentText === undefined ? {} : { contentText }),
      });
      services.indexer.indexNote(note.id);
      return { note };
    },

    'note:list': ({ limit, offset }) => db.notes.list(limit, offset),

    'note:listForAnnotation': ({ annotationId }) => ({
      notes: db.notes.listForAnnotation(annotationId),
    }),

    // --- Questions: the queue ---------------------------------------------
    'question:create': ({ title, status, importance, nextAction }) => ({
      question: db.questions.create({
        title,
        ...(status === undefined ? {} : { status }),
        ...(importance === undefined || importance === null ? {} : { importance }),
        ...(nextAction === undefined || nextAction === null ? {} : { nextAction }),
      }),
    }),

    'question:get': ({ questionId }) => {
      const question = db.questions.get(questionId);
      if (question === null) throw notFound('notebook', questionId);
      return { question };
    },

    'question:list': ({ status }) => ({
      questions: db.questions.list(status === undefined ? {} : { status }),
    }),

    'question:update': ({
      questionId,
      title,
      status,
      importance,
      nextAction,
      description,
      tags,
      coverFileId,
      journalStart,
    }) => {
      if (db.questions.get(questionId) === null) throw notFound('notebook', questionId);
      // A cover names a file the library already holds. Checked here rather than trusted,
      // because a cover pointing at nothing is a broken image the moment it is written.
      if (coverFileId !== undefined && coverFileId !== null) {
        if (db.files.getById(coverFileId) === null) throw notFound('documentFile', coverFileId);
      }
      if (status === 'discarded') {
        // Not an oversight: `question:discard` carries the reason, and this channel has no
        // field for one. Routing the transition here would lose it.
        throw new HandlerError(
          'INVALID_REQUEST',
          'discarding a question goes through question:discard, which carries the reason',
          { questionId },
        );
      }
      return {
        question: db.questions.update(questionId, {
          ...(title === undefined ? {} : { title }),
          ...(status === undefined ? {} : { status }),
          ...(importance === undefined ? {} : { importance }),
          ...(nextAction === undefined ? {} : { nextAction }),
          ...(description === undefined ? {} : { description }),
          ...(tags === undefined ? {} : { tags }),
          ...(coverFileId === undefined ? {} : { coverFileId }),
          ...(journalStart === undefined ? {} : { journalStart }),
        }),
      };
    },

    'question:discard': ({ questionId, reason }) => {
      if (db.questions.get(questionId) === null) throw notFound('notebook', questionId);
      return { question: db.questions.discard(questionId, reason) };
    },

    /**
     * Deleted, which means in the bin (`U11`, superseding `I01`'s confirmed-and-gone).
     *
     * The precondition is still the point, and it is unchanged: discarding is reversible and
     * carries the reason, and deleting is only offered on the discarded shelf. Enforcing that
     * here rather than only in the panel is what keeps the two acts genuinely distinct instead
     * of two buttons with different labels. What changed is what deleting *does* — the
     * notebook goes somewhere, with everything it had, and comes back from there. The only
     * thing in this application that destroys a line of work is `question:emptyTrash`.
     *
     * Announced the same way as before: a notebook in the bin is off every list, so the page
     * and the shelves have to hear about it.
     */
    'question:delete': ({ questionId }) => {
      const notebook = db.questions.get(questionId);
      if (notebook === null) throw notFound('notebook', questionId);
      if (notebook.status !== 'discarded') {
        throw new HandlerError(
          'INVALID_REQUEST',
          'a notebook is discarded before it is deleted — discarding keeps the reason, and comes back',
          { questionId },
        );
      }
      const question = db.questions.trash(questionId);
      services.publish('notebook:changed', { questionId, reason: 'deleted', added: 0 });
      services.publish('library:changed', { reason: 'link', documentIds: [] });
      return { question };
    },

    'question:restoreFromTrash': ({ questionId }) => {
      if (db.questions.get(questionId) === null) throw notFound('notebook', questionId);
      const question = db.questions.restoreFromTrash(questionId);
      services.publish('library:changed', { reason: 'link', documentIds: [] });
      return { question };
    },

    /**
     * The one act in the application that destroys a line of work (`U11`).
     *
     * No argument: emptying a bin is one decision about everything in it. Each notebook is
     * announced by id before the summary is returned, because a page or a journal open on one
     * of them has to stop showing a notebook that is not there — and the page does not know
     * the bin exists, only its own id.
     */
    'question:emptyTrash': () => {
      const going = db.questions.listTrashed().map((question) => question.id);
      const removed = db.questions.emptyTrash();
      for (const questionId of going) {
        services.publish('notebook:changed', { questionId, reason: 'deleted', added: 0 });
      }
      services.publish('library:changed', { reason: 'link', documentIds: [] });
      return { removed };
    },

    'question:reorder': ({ questionIds }) => {
      for (const id of questionIds) {
        if (db.questions.get(id) === null) throw notFound('notebook', id);
      }
      return { questions: db.questions.reorder(questionIds) };
    },

    'question:attach': ({ questionId, targetType, targetId, label, landsAsBlock }) => {
      if (db.questions.get(questionId) === null) throw notFound('notebook', questionId);
      // Both endpoints are checked here rather than trusted from the caller: an edge to a
      // paper that is not in the library is a broken link the moment it is written.
      const exists =
        targetType === 'document'
          ? db.documents.getById(targetId) !== null
          : db.annotations.get(targetId) !== null;
      if (!exists) throw notFound(targetType, targetId);
      const link = db.links.create({
        type: `question-references-${targetType}`,
        sourceType: 'question',
        sourceId: questionId,
        targetType,
        targetId,
        label: label ?? null,
        origin: 'manual',
      });
      // …and it lands on the page as a block (`P06`). The edge is the durable half — it is
      // what the graph, the ledger and the references panel read — and the block is the half
      // the researcher can see and write around. There is no desk left to draw the edge on,
      // so a send that wrote only the edge would be a gesture with no visible result.
      const landing = landsAsBlock
        ? notebookLandingBlock(db, targetType, targetId, db.questions.readBodyFormat(questionId))
        : null;
      const added = appendNotebookBlocks(db, questionId, landing === null ? [] : [landing]);
      // Said out loud, because the sender is usually not the notebook (`E01`): a reader sends
      // a highlight and the page, if it is open beside it, has to grow the block without being
      // reopened. The page it *is* sent from also hears this and re-reads its body, which is
      // one redundant read and no second mechanism.
      services.publish('notebook:changed', { questionId, reason: 'attach', added });
      return { link };
    },

    // --- Field notebooks --------------------------------------------------
    'question:notebook': ({ questionId }) => ({ page: notebookPage(db, questionId) }),

    /**
     * Every notebook, with what its log amounts to (`P01`).
     *
     * In the hand-arranged order, like every other list of notebooks: the directory is a way
     * in, not a second opinion about what matters. Discarded ones are included — the
     * directory is the whole shelf, and the page is what decides how to show them.
     */
    'notebook:directory': () => ({
      notebooks: db.questions.list().map((notebook) => {
        const dates = db.journal.loggedDates(notebook.id);
        return {
          notebook,
          entries: dates.length,
          lastEntry: dates.at(-1) ?? null,
          journalStart: db.journal.start(notebook.id),
        };
      }),
    }),

    'question:writeNotebook': ({ questionId, body }) => {
      if (db.questions.get(questionId) === null) throw notFound('notebook', questionId);
      db.questions.writeBody(questionId, body);
      return { page: notebookPage(db, questionId) };
    },

    /**
     * This notebook's own Typst header (`S05`).
     *
     * Refused when it does not compile, and the stored one is left alone — a header is code
     * every block of the page is compiled against, so storing a broken one would blank the
     * whole page and leave no surface on which to fix it. The page comes back either way, with
     * the reason beside it.
     */
    'notebook:writeHeader': async ({ questionId, header }) => {
      if (db.questions.get(questionId) === null) throw notFound('notebook', questionId);
      const error = await typstService(services).checkHeader(header);
      if (error === null) db.questions.writeTypstHeader(questionId, header);
      return { page: notebookPage(db, questionId), error };
    },

    'hypothesis:create': ({ questionId, statement, status }) => {
      if (db.questions.get(questionId) === null) throw notFound('notebook', questionId);
      return {
        hypothesis: db.hypotheses.create({
          questionId,
          statement,
          ...(status === undefined ? {} : { status }),
        }),
      };
    },

    'hypothesis:list': () => ({ claims: db.hypotheses.listAll() }),

    'hypothesis:update': ({ hypothesisId, statement, status }) => {
      if (db.hypotheses.get(hypothesisId) === null) throw notFound('hypothesis', hypothesisId);
      return {
        hypothesis: db.hypotheses.update(hypothesisId, {
          ...(statement === undefined ? {} : { statement }),
          ...(status === undefined ? {} : { status }),
        }),
      };
    },

    'hypothesis:attachEvidence': ({ hypothesisId, stance, sourceType, sourceId, label }) => {
      if (db.hypotheses.get(hypothesisId) === null) throw notFound('hypothesis', hypothesisId);
      // Both endpoints are checked before the edge is written. A citation to something that
      // is not in the wiki is evidence-shaped text, which is the thing this channel exists
      // to refuse.
      const exists =
        sourceType === 'document'
          ? db.documents.getById(sourceId) !== null
          : db.annotations.get(sourceId) !== null;
      if (!exists) throw notFound(sourceType, sourceId);
      const link = db.links.create({
        type: `${sourceType}-${stance}-hypothesis`,
        sourceType,
        sourceId,
        targetType: 'hypothesis',
        targetId: hypothesisId,
        label: label ?? null,
        origin: 'manual',
      });
      // The librarian's route to the same edge the researcher makes by hand (`E02`). It used
      // to announce nothing at all, so a page open on the claim never heard.
      announceLink(link);
      return { link };
    },

    // --- The journal ------------------------------------------------------
    // Every one of these names the notebook whose log it is (`P02`). The notebook is checked
    // to exist before anything else: a day written under a notebook that is not there would
    // be an orphan the calendar could never show again.
    'journal:get': ({ notebookId, date }) => {
      if (db.questions.get(notebookId) === null) throw notFound('notebook', notebookId);
      return { entry: db.journal.get(notebookId, date) };
    },

    'journal:write': ({ notebookId, date, markdown }) => {
      if (db.questions.get(notebookId) === null) throw notFound('notebook', notebookId);
      return { entry: db.journal.write(notebookId, date, markdown) };
    },

    'journal:loggedDates': ({ notebookId, from, to }) => {
      if (db.questions.get(notebookId) === null) throw notFound('notebook', notebookId);
      return {
        dates: db.journal.loggedDates(notebookId, {
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
        }),
        journalStart: db.journal.start(notebookId),
      };
    },

    'journal:advancesNotebook': ({ notebookId, date, advancesId }) => {
      // Both ends are checked here: an edge from a day nobody wrote on, or to a notebook
      // that is not in the library, is a broken link the moment it is created.
      if (db.journal.get(notebookId, date) === null) {
        throw notFound('journal entry', journalEntityId(notebookId, date));
      }
      if (db.questions.get(advancesId) === null) throw notFound('notebook', advancesId);
      return {
        link: db.links.create({
          type: 'journal-entry-advances-question',
          sourceType: 'journal',
          sourceId: journalEntityId(notebookId, date),
          targetType: 'question',
          targetId: advancesId,
          origin: 'manual',
        }),
      };
    },

    // --- Links ------------------------------------------------------------
    // Both writes announce themselves, twice. A link is not a private fact about the two rows
    // it names: the ledger, the wiki page, the focused view and the neighbourhood panel are
    // all drawings of the link table, and each of them holding the picture it had when it
    // mounted is how a researcher ends up making the same connection twice. `announceLink`
    // also tells the notebook whose claim, desk or day was an end of it — the milestone's own
    // layout is a reader beside a notebook, and `E02`'s gesture happens in the reader.
    'link:create': (request) => {
      const link = db.links.create({
        type: request.type,
        sourceType: request.sourceType,
        sourceId: request.sourceId,
        targetType: request.targetType,
        targetId: request.targetId,
        sourceLocation: request.sourceLocation ?? null,
        targetLocation: request.targetLocation ?? null,
        label: request.label ?? null,
        ordinal: request.ordinal ?? null,
        origin: request.origin,
        generator: request.generator ?? null,
        metadata: request.metadata ?? null,
      });
      announceLink(link);
      return { link };
    },

    'link:delete': ({ linkId }) => {
      const link = db.links.getById(linkId);
      if (link === null) throw notFound('link', linkId);
      // A generated edge is not the researcher's to take away (`H07`). The guard is here, in
      // the one channel that destroys an edge, rather than only on the four surfaces that
      // draw one: a wikilink deleted through any of them came back on the next corpus scan
      // with nothing said, and the containment edge deleted through the neighbourhood panel
      // did not come back at all. Both are `origin: 'derived'`, and neither is a link.
      const refusal = unlinkRefusal(link);
      if (refusal !== null) {
        throw new HandlerError(
          'CONFLICT',
          refusal,
          { linkId, type: link.type, generator: link.generator },
          'Only links you made by hand can be taken away here.',
        );
      }
      const deleted = db.links.delete(linkId);
      if (!deleted) throw notFound('link', linkId);
      announceLink(link);
      return { deleted };
    },

    'link:findForDocument': ({ documentId, limit }) => {
      if (db.documents.getById(documentId) === null) throw notFound('document', documentId);
      return {
        entries: db.links.findForDocument({ documentId, limit }),
        // The file's marked sentences, edges or not (`E03`) — the half of a ledger that
        // cannot be derived from the edges, because its whole point is the ones with none.
        highlights: db.links.highlightsForDocument({ documentId }),
      };
    },

    'link:findReferences': ({ entityType, entityId, direction, limit }) => ({
      links: db.links.findReferences({ entityType, entityId, direction, limit }),
    }),

    'link:findByType': (request) => ({
      links: db.links.findByType({
        type: request.type,
        ...(request.documentId === undefined ? {} : { documentId: request.documentId }),
        ...(request.collectionId === undefined ? {} : { collectionId: request.collectionId }),
        ...(request.sourceType === undefined ? {} : { sourceType: request.sourceType }),
        ...(request.targetType === undefined ? {} : { targetType: request.targetType }),
        direction: request.direction,
        ...(request.origin === undefined ? {} : { origin: request.origin }),
        ...(request.generator === undefined ? {} : { generator: request.generator }),
        ...(request.createdAfter === undefined ? {} : { createdAfter: request.createdAfter }),
        ...(request.createdBefore === undefined ? {} : { createdBefore: request.createdBefore }),
        ...(request.tag === undefined ? {} : { tag: request.tag }),
        limit: request.limit,
      }),
    }),

    'link:getParent': ({ entityType, entityId }) => {
      const parent = db.entities.parentOf(entityType, entityId);
      if (parent === null) return { parent: null };
      return {
        parent: {
          entityType: parent.entityType,
          entityId: parent.entityId,
          title: parent.title,
          documentId: parent.documentId,
          location: parent.location,
        },
      };
    },

    'link:peek': ({ entityType, entityId }) => {
      const described = db.entities.describe(entityType, entityId);
      const counts = db.links.counts(entityType, entityId);
      const parent = db.entities.parentOf(entityType, entityId);

      // A peek at something that no longer resolves still answers, flagged `broken`. The
      // widget needs to say "this link is dead" rather than fail to open.
      if (described === null) {
        return {
          title: entityId,
          entityType,
          documentTitle: null,
          documentId: null,
          excerpt: '',
          locationLabel: '',
          location: null,
          parentLabel: parent?.title ?? null,
          incomingCount: counts.incoming,
          outgoingCount: counts.outgoing,
          broken: true,
        };
      }

      const documentTitle =
        described.documentId === null
          ? null
          : (db.documents.getById(described.documentId)?.title ?? null);

      return {
        title: described.title,
        entityType: described.entityType,
        documentTitle,
        documentId: described.documentId,
        excerpt: described.excerpt,
        locationLabel: locationLabel(described.location),
        location: described.location,
        parentLabel: parent?.title ?? null,
        incomingCount: counts.incoming,
        outgoingCount: counts.outgoing,
        broken: false,
      };
    },

    // --- Graph ------------------------------------------------------------
    // The traversal happens here, against SQLite. What goes back is the subgraph the request
    // asked for — a seed, a radius, a node cap — and the count of what the cap dropped.
    'graph:neighbourhood': ({ seedType, seedId, depth, nodeLimit }) =>
      db.graph.neighbourhood({ seedType, seedId, depth, nodeLimit }),

    // The wiki page (`F01`). The cap is the contract's and arrives already validated; what the
    // repository adds is the ranking and the count of what it left out.
    'graph:overview': ({ nodeLimit, edgeLimit }) => db.graph.overview({ nodeLimit, edgeLimit }),

    // The focused view (`F02`, `F03`). A file that does not resolve is not an empty view of
    // nothing — it is a file that is not there, and the panel says so.
    'graph:focus': ({ documentId, annotationLimit, neighbourLimit }) => {
      const focused = db.graph.focus({ documentId, annotationLimit, neighbourLimit });
      if (focused === null) throw notFound('document', documentId);
      return focused;
    },

    // How the graph is drawn and where it was left. Both are preferences, so both come back
    // in one answer: a panel that mounts draws once rather than drawing a default and jumping.
    'graph:getView': ({ seedType, seedId }) => ({
      settings: db.graphView.viewSettings(),
      viewport:
        seedType === null || seedId === null ? null : db.graphView.viewport(seedType, seedId),
    }),

    'graph:setViewSettings': (settings) => ({
      settings: db.graphView.saveViewSettings(settings),
    }),

    // --- Typst (`S04`–`S07`) ------------------------------------------------
    // The whole compiler boundary. The addon is loaded only here, so the renderer has no way
    // to reach it and the verifier's forbidden-import list can say so.
    'typst:render': async (request) => typstService(services).render(request),

    'typst:getSettings': () => ({ settings: typstService(services).settings() }),

    'typst:setSettings': async (change) => typstService(services).saveSettings(change),

    // The rename lands in `graph_node_names` and touches no document row: the title stays
    // whatever the provider says it is, so the next import has nothing to overwrite.
    'graph:setNodeName': ({ entityType, entityId, displayName }) => ({
      displayName: db.graph.setDisplayName(entityType, entityId, displayName),
    }),

    'graph:iconChoices': ({ limit }) => ({
      choices: db.files.listImages(limit).map((choice) => ({
        fileId: DocumentFileIdSchema.parse(choice.fileId),
        title: choice.title,
      })),
    }),

    /**
     * The picture on a node (criterion G04).
     *
     * Two checks, and neither is a formality. The id must name a file the library actually
     * holds, or the node draws a broken picture from the moment it is set. And that file must
     * be an *image*: `rrfile://` serves whatever the row says its type is, so a node pointing
     * at a PDF would put a document's bytes behind an `<image>` element — a way of asking for
     * a file that has nothing to do with illustrating anything.
     */
    'graph:setNodeIcon': ({ entityType, entityId, fileId }) => {
      if (fileId !== null) {
        const file = db.files.getById(fileId);
        if (file === null) throw notFound('documentFile', fileId);
        if (!/^image\//i.test(file.mimeType)) {
          throw new HandlerError('INVALID_REQUEST', 'a node icon has to be an image', {
            fileId,
            mimeType: file.mimeType,
          });
        }
      }
      const saved = db.graph.setIcon(entityType, entityId, fileId);
      return { iconFileId: saved === null ? null : DocumentFileIdSchema.parse(saved) };
    },

    'graph:setViewport': ({ seedType, seedId, viewport }) => ({
      viewport: db.graphView.saveViewport(seedType, seedId, viewport),
    }),

    // --- Demo content (criterion B07) --------------------------------------
    'demo:status': () => services.demo.status(),

    /**
     * Fill every surface with synthetic content, or take it away again.
     *
     * The refusal is the criterion's other half: a packaged build has no demo, so this is a
     * `CONFLICT` raised before a file is written rather than a switch a preferences panel
     * happens not to draw. Both actions announce, because every open panel is a view of what
     * just changed and none of them subscribe to a channel of their own.
     */
    'demo:fill': async () => {
      try {
        const summary = await services.demo.fill();
        // One announcement, on the channel every list already listens to. The workspace
        // re-reads the library and the notebook shelves off it, so nothing new subscribes and
        // no panel has to learn that a demo exists.
        services.publish('library:changed', { reason: 'import', documentIds: [] });
        return summary;
      } catch (error) {
        throw demoFailure(error);
      }
    },

    'demo:clear': () => {
      try {
        const summary = services.demo.clear();
        services.publish('library:changed', { reason: 'delete', documentIds: [] });
        return summary;
      } catch (error) {
        throw demoFailure(error);
      }
    },

    // --- Card art ---------------------------------------------------------
    'cardArt:status': () => cardArtStatus(db),

    'cardArt:disclosure': () => cardArtDisclosure(db),

    'cardArt:enable': ({ enabled, acknowledgeDisclosure }) => {
      try {
        return cardArtStatus(
          db,
          setCardArtEnabled(db, { enabled, acknowledgeDisclosure }, new Date().toISOString()),
        );
      } catch (error) {
        if (error instanceof CardArtDisclosureNotAcknowledgedError) {
          throw new HandlerError(
            'CONFLICT',
            error.message,
            {},
            'Read what a fetch would send and where it goes, then turn it on from the same place.',
          );
        }
        throw error;
      }
    },

    /**
     * A page of the gallery the icon picker is (criterion `B06`).
     *
     * The same refusal `cardArt:fetch` opens with, because the listing is a request like any
     * other: with card art off, opening the picker must not be what makes this application
     * talk to a server.
     */
    'cardArt:gallery': async ({ offset, limit }) => {
      try {
        const page = await services.cardArt.gallery({ offset, limit });
        return { ...page, setName: CARD_ART_SET_NAME };
      } catch (error) {
        if (error instanceof CardArtDisabledError) {
          throw new HandlerError(
            'CONFLICT',
            error.message,
            {},
            'Turn card art on first. It is off until you do, and nothing is fetched.',
          );
        }
        if (error instanceof CardArtRefusedError) {
          throw new HandlerError('INVALID_REQUEST', error.message, {});
        }
        throw error;
      }
    },

    /**
     * Art for a named card, on a node (criterion G05).
     *
     * The two refusals are the criterion. Off means *no request*, so it is a `CONFLICT` raised
     * before a URL is built rather than a fetch whose answer is discarded; and a reply that is
     * not one of four image types is refused before its bytes touch the cache directory, where
     * `rrfile://` would otherwise be willing to serve them.
     */
    'cardArt:fetch': async ({ entityType, entityId, name }) => {
      try {
        const art = await services.cardArt.illustrate({ entityType, entityId, name });
        return { iconFileId: DocumentFileIdSchema.parse(art.fileId), fromCache: art.fromCache };
      } catch (error) {
        if (error instanceof CardArtDisabledError) {
          throw new HandlerError(
            'CONFLICT',
            error.message,
            {},
            'Turn card art on first. It is off until you do, and nothing is fetched.',
          );
        }
        if (error instanceof CardArtRefusedError) {
          throw new HandlerError('INVALID_REQUEST', error.message, { name });
        }
        throw error;
      }
    },

    // --- Search -----------------------------------------------------------
    'search:query': ({ query, filters, limit, offset }) =>
      services.search.search(query, { filters, limit, offset }),

    'search:status': () => {
      const counts = db.jobs.counts();
      return {
        queued: counts.queued,
        running: counts.running,
        failed: counts.failed,
        indexedDocuments: db.searchIndex.indexedDocumentCount(),
        totalDocuments: db.documents.count(),
      };
    },

    // --- The librarian ----------------------------------------------------
    // Answering either of the first two starts nothing. That is the whole of `A03` on this
    // side of the boundary: the panel an interface paints before anything is enabled asks
    // both of these, and neither may materialise the wiki, spawn a process or arm a timer.
    'agent:status': () => agentStatus(),

    'agent:disclosure': () => agentDisclosure(db, readAgentSettings(db), services.agents.executable),

    'agent:enable': async ({ enabled, acknowledgeDisclosure }) => {
      let settings;
      try {
        settings = setAgentsEnabled(db, { enabled, acknowledgeDisclosure }, new Date().toISOString());
      } catch (error) {
        if (error instanceof DisclosureNotAcknowledgedError) {
          throw new HandlerError(
            'CONFLICT',
            error.message,
            {},
            'Read what a run would send, then enable it from the same panel.',
          );
        }
        throw error;
      }
      // The timer is started here rather than at startup, because "off" has to mean that
      // nothing is scheduled — not that a scheduled pass would decline to run.
      if (settings.enabled) services.agents.scheduler.start();
      else {
        services.agents.scheduler.stop();
        services.agents.runner.cancelAll();
        // Switching off has to undo what switching on made, not merely stop making more.
        // `README.md` and the disclosure's withhold line say no copy of the wiki is made with
        // agents off, and both are read by someone deciding whether they can change their
        // mind. Leaving the copy would leave every document's full text, every highlight and
        // every journal entry sealed on disk after they had.
        await services.agents.view.remove();
      }
      logger.info('agents switched', { enabled: settings.enabled });
      return agentStatus();
    },

    'agent:setCapabilities': ({ capabilities }) => {
      writeAgentSettings(db, { capabilities });
      return agentStatus();
    },

    'agent:run': async () => {
      const settings = readAgentSettings(db);
      if (!settings.enabled) {
        throw new HandlerError(
          'CONFLICT',
          'Agents are off.',
          {},
          'Enable the librarian first; it will tell you what a run would send.',
        );
      }
      // The librarian, not the runner: a pass materialises the whole wiki before it spawns,
      // and the runner is not busy for any of that.
      if (services.agents.librarian.busy || services.agents.runner.busy) {
        throw new HandlerError('CONFLICT', 'A pass is already running.');
      }
      const pass = await services.agents.librarian.pass(
        { trigger: 'manual', capabilities: settings.capabilities },
        (event, runId) =>
          services.publish(
            'agent:progress',
            agentProgress(runId, event, services.agents.progressRoots),
          ),
      );
      return {
        runId: AgentRunIdSchema.parse(pass.run.id),
        status: pass.run.status === 'running' ? ('finished' as const) : pass.run.status,
        proposals: pass.proposals.length,
        rejected: pass.rejected,
      };
    },

    'agent:cancel': ({ runId }) => ({ cancelled: services.agents.runner.cancel(runId) }),

    'agent:listProposals': ({ status, limit }) => {
      const listed = db.agentRuns.listProposals(status === undefined ? {} : { status });
      return { proposals: listed.items.slice(0, limit).map(toAgentProposal) };
    },

    'agent:accept': async ({ proposalId }) => {
      const stored = db.agentRuns.getProposal(proposalId);
      if (stored === null) throw notFound('Proposal', proposalId);
      if (stored.status !== 'pending') {
        throw new HandlerError('CONFLICT', `That proposal was already ${stored.status}.`);
      }
      const accepted = await services.agents.librarian.accept(proposalId);
      // The note is a document now, so every list that shows documents is out of date.
      services.publish('library:changed', { reason: 'import', documentIds: [] });
      return { proposal: toAgentProposal(accepted.proposal) };
    },

    'agent:reject': ({ proposalId }) => {
      const stored = db.agentRuns.getProposal(proposalId);
      if (stored === null) throw notFound('Proposal', proposalId);
      if (stored.status !== 'pending') {
        throw new HandlerError('CONFLICT', `That proposal was already ${stored.status}.`);
      }
      return { proposal: toAgentProposal(services.agents.librarian.reject(proposalId)) };
    },

    // --- Workspace --------------------------------------------------------
    'workspace:loadLayout': ({ name }) => ({ layout: db.layouts.load(name) }),

    'workspace:saveLayout': ({ name, layout, panelState }) => {
      db.layouts.save(name, layout, panelState);
      return { saved: true };
    },
  };
}
