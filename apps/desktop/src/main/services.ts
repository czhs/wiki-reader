/**
 * The main-process service container.
 *
 * Everything the IPC handlers need, assembled in one place and free of Electron imports so
 * that the entire backend can be constructed inside a vitest process against a temporary
 * database. That is what makes the persistence criteria (M08, M09, M10, M12, M13, M14)
 * testable as real integration rather than as mocks.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type WikiReaderDatabase } from '@wr/database';
import { SearchService, SearchIndexer } from '@wr/search';
import { ZoteroImporter, ZoteroLocalClient, defaultZoteroDataDir } from '@wr/zotero-adapter';
import { DocumentIdSchema, type IpcTopic, type IpcTopicPayload } from '@wr/shared-types';
import { createLogger, silentLogger, type Logger } from './logger.js';
import { allowedRoots, type AllowedRoots } from './paths.js';
import { ExtractionPipeline, type PdfExtractor } from './pipeline.js';
import { MarkdownCorpusImporter } from './corpus.js';

export interface AppServices {
  readonly db: WikiReaderDatabase;
  readonly zotero: ZoteroLocalClient;
  readonly importer: ZoteroImporter;
  readonly search: SearchService;
  readonly indexer: SearchIndexer;
  readonly pipeline: ExtractionPipeline;
  /** Ingests the markdown corpus. Its root is configured here, never sent by the renderer. */
  readonly corpus: MarkdownCorpusImporter;
  readonly corpusRoot: string;
  readonly logger: Logger;
  readonly allowed: AllowedRoots;
  /** Push an event to every renderer. A no-op when no window exists yet. */
  readonly publish: <K extends IpcTopic>(topic: K, payload: IpcTopicPayload<K>) => void;
  readonly close: () => void;
}

export interface CreateServicesOptions {
  /** Absolute path to the SQLite file, or ':memory:'. */
  readonly databasePath: string;
  /** Path to the better-sqlite3 build matching the host ABI. */
  readonly nativeBinding?: string | undefined;
  readonly zoteroDataDir?: string | undefined;
  /** Root of the markdown corpus. Defaults to `WR_MARKDOWN_ROOT`, then `<userData>/corpus`. */
  readonly markdownRoot?: string | undefined;
  readonly zoteroEndpoint?: string | undefined;
  readonly logger?: Logger | undefined;
  readonly publish?: (<K extends IpcTopic>(topic: K, payload: IpcTopicPayload<K>) => void) | undefined;
  /** Injectable so pipeline tests need not parse a real PDF. */
  readonly extractPdf?: PdfExtractor | undefined;
  /** Extra directories the file protocol and extractor may read from. Tests use this. */
  readonly extraRoots?: readonly string[] | undefined;
}

export function createServices(options: CreateServicesOptions): AppServices {
  const logger = options.logger ?? createLogger();
  const zoteroDataDir = options.zoteroDataDir ?? defaultZoteroDataDir();

  const { db, migration } = openDatabase({
    file: options.databasePath,
    nativeBinding: options.nativeBinding,
  });
  logger.info('database ready', {
    path: options.databasePath,
    version: migration.version,
    applied: migration.applied.length,
  });

  const corpusRoot = options.markdownRoot ?? defaultMarkdownRoot();
  const allowed = allowedRoots(zoteroDataDir, corpusRoot, ...(options.extraRoots ?? []));
  const publish = options.publish ?? ((): void => undefined);

  const pipeline = new ExtractionPipeline(db, {
    logger,
    allowed,
    ...(options.extractPdf === undefined ? {} : { extractPdf: options.extractPdf }),
    onProgress: (progress) => {
      publish('indexing:progress', {
        documentId: DocumentIdSchema.parse(progress.documentId),
        stage: progress.stage,
        processed: progress.processed,
        total: progress.total,
        ...(progress.message === undefined ? {} : { message: progress.message }),
      });
    },
  });

  const zotero = new ZoteroLocalClient({
    ...(options.zoteroEndpoint === undefined ? {} : { endpoint: options.zoteroEndpoint }),
  });

  const importer = new ZoteroImporter(zotero, db, {
    dataDir: zoteroDataDir,
    logger: {
      info: (event, fields) => logger.child('zotero').info(event, fields),
      warn: (event, fields) => logger.child('zotero').warn(event, fields),
    },
    onProgress: (progress) => {
      publish('zotero:importProgress', {
        phase: progress.phase,
        processed: progress.processed,
        total: progress.total,
      });
    },
  });

  return {
    db,
    zotero,
    importer,
    search: new SearchService(db),
    indexer: new SearchIndexer(db, {
      info: (message, fields) => logger.child('index').info(message, fields),
      warn: (message, fields) => logger.child('index').warn(message, fields),
    }),
    pipeline,
    corpus: new MarkdownCorpusImporter(db, { root: corpusRoot, allowed, logger }),
    corpusRoot,
    logger,
    allowed,
    publish,
    close: () => {
      db.close();
      logger.info('database closed');
    },
  };
}

/**
 * Where the wiki lives when nothing says otherwise.
 *
 * `WR_MARKDOWN_ROOT` is read from the environment of the *main* process, so the corpus
 * location is a property of the installation rather than something a renderer can name.
 */
export function defaultMarkdownRoot(): string {
  const configured = process.env['WR_MARKDOWN_ROOT'];
  if (configured !== undefined && configured.length > 0) return configured;
  return join(homedir(), 'wiki-reader', 'corpus');
}

/** Convenience for tests: a service container that logs nowhere. */
export function createTestServices(
  options: Omit<CreateServicesOptions, 'logger'> & { logger?: Logger },
): AppServices {
  return createServices({ ...options, logger: options.logger ?? silentLogger });
}
