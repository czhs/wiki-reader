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
import { toDocumentFileRef, type WikiReaderDatabase } from '@wr/database';
import {
  DocumentIdSchema,
  type DocumentLocation,
  type IpcChannel,
  type IpcError,
  type IpcRequestParsed,
  type IpcResponse,
  type LinkableEntityType,
} from '@wr/shared-types';
import type { AppServices } from './services.js';

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

export function createHandlers(services: AppServices): Handlers {
  const { db, logger } = services;

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

    'zotero:import': async ({ force, collection }) => {
      const summary = await services.importer.import({
        force,
        ...(collection === undefined ? {} : { collection }),
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
