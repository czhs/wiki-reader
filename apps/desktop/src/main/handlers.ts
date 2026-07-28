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
import type { AgentRunRecord, StoredProposal } from '@wr/database';
import { toDocumentFileRef, type WikiReaderDatabase } from '@wr/database';
import {
  AgentProposalIdSchema,
  AgentRunIdSchema,
  DocumentIdSchema,
  ProposalCitationSchema,
  type AgentProposal,
  type AgentRunSummary,
  type DocumentLocation,
  type IpcChannel,
  type IpcError,
  type IpcRequestParsed,
  type IpcResponse,
  type LinkableEntityType,
} from '@wr/shared-types';
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
      const summary = await services.importer.import({ force, collections: scope });
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
      if (question === null) throw notFound('question', questionId);
      return { question };
    },

    'question:list': ({ status }) => ({
      questions: db.questions.list(status === undefined ? {} : { status }),
    }),

    'question:update': ({ questionId, title, status, importance, nextAction }) => {
      if (db.questions.get(questionId) === null) throw notFound('question', questionId);
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
        }),
      };
    },

    'question:discard': ({ questionId, reason }) => {
      if (db.questions.get(questionId) === null) throw notFound('question', questionId);
      return { question: db.questions.discard(questionId, reason) };
    },

    'question:reorder': ({ questionIds }) => {
      for (const id of questionIds) {
        if (db.questions.get(id) === null) throw notFound('question', id);
      }
      return { questions: db.questions.reorder(questionIds) };
    },

    'question:attach': ({ questionId, targetType, targetId, label }) => {
      if (db.questions.get(questionId) === null) throw notFound('question', questionId);
      // Both endpoints are checked here rather than trusted from the caller: an edge to a
      // paper that is not in the library is a broken link the moment it is written.
      const exists =
        targetType === 'document'
          ? db.documents.getById(targetId) !== null
          : db.annotations.get(targetId) !== null;
      if (!exists) throw notFound(targetType, targetId);
      return {
        link: db.links.create({
          type: `question-references-${targetType}`,
          sourceType: 'question',
          sourceId: questionId,
          targetType,
          targetId,
          label: label ?? null,
          origin: 'manual',
        }),
      };
    },

    // --- The journal ------------------------------------------------------
    'journal:get': ({ date }) => ({ entry: db.journal.get(date) }),

    'journal:write': ({ date, markdown }) => ({ entry: db.journal.write(date, markdown) }),

    'journal:loggedDates': ({ from, to }) => ({
      dates: db.journal.loggedDates({
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
      }),
      firstDate: db.journal.firstDate(),
    }),

    'journal:advancesQuestion': ({ date, questionId }) => {
      // Both ends are checked here: an edge from a day nobody wrote on, or to a question
      // that is not in the queue, is a broken link the moment it is created.
      if (db.journal.get(date) === null) throw notFound('journal entry', date);
      if (db.questions.get(questionId) === null) throw notFound('question', questionId);
      return {
        link: db.links.create({
          type: 'journal-entry-advances-question',
          sourceType: 'journal',
          sourceId: date,
          targetType: 'question',
          targetId: questionId,
          origin: 'manual',
        }),
      };
    },

    // --- Links ------------------------------------------------------------
    'link:create': (request) => ({
      link: db.links.create({
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
      }),
    }),

    'link:delete': ({ linkId }) => {
      const deleted = db.links.delete(linkId);
      if (!deleted) throw notFound('link', linkId);
      return { deleted };
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

/** Entity types a peek or reference query may legitimately target. */
export const PEEKABLE: readonly LinkableEntityType[] = [
  'document',
  'annotation',
  'note',
  'chunk',
  'collection',
];
