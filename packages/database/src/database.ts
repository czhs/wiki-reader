import type { Database as SqliteDatabase } from 'better-sqlite3';
import { openSqlite, type SqliteOpenOptions } from './connection.js';
import { systemClock, type Clock } from './clock.js';
import { runMigrations, schemaVersion, type MigrationResult } from './migrator.js';
import { EntityResolver } from './entity-resolver.js';
import {
  DocumentChunksRepository,
  DocumentFilesRepository,
  DocumentRevisionsRepository,
  DocumentsRepository,
} from './repositories/documents.js';
import { AnnotationsRepository } from './repositories/annotations.js';
import { NotesRepository } from './repositories/notes.js';
import { QuestionsRepository } from './repositories/questions.js';
import { JournalRepository } from './repositories/journal.js';
import { LinksRepository } from './repositories/links.js';
import { GraphRepository } from './repositories/graph.js';
import { CollectionsRepository, TagsRepository } from './repositories/organisation.js';
import { ReadingPositionsRepository, WorkspaceLayoutsRepository } from './repositories/session.js';
import { ExternalReferencesRepository } from './repositories/external-references.js';
import { IndexingJobsRepository } from './repositories/indexing-jobs.js';
import { SearchIndexRepository } from './repositories/search-index.js';
import { LibraryRepository } from './repositories/library.js';
import { WantedPagesRepository } from './repositories/wanted-pages.js';
import { SettingsRepository } from './repositories/settings.js';
import { AgentRunsRepository } from './repositories/agents.js';

export interface OpenDatabaseOptions extends SqliteOpenOptions {
  /** Skip the migration run. Only useful for inspecting an existing file. */
  readonly migrate?: boolean | undefined;
  readonly clock?: Clock | undefined;
}

/**
 * The application database.
 *
 * Everything that touches SQL goes through a repository on this object. No SQL is written
 * anywhere else — not in IPC handlers, not in the renderer, not in workers.
 *
 * Main process only. Renderer packages cannot import this: both ESLint and
 * `scripts/verify_completion.py` enforce that boundary.
 */
export class WikiReaderDatabase {
  readonly documents: DocumentsRepository;
  readonly revisions: DocumentRevisionsRepository;
  readonly files: DocumentFilesRepository;
  readonly chunks: DocumentChunksRepository;
  readonly annotations: AnnotationsRepository;
  readonly notes: NotesRepository;
  readonly questions: QuestionsRepository;
  readonly journal: JournalRepository;
  readonly links: LinksRepository;
  readonly graph: GraphRepository;
  readonly collections: CollectionsRepository;
  readonly tags: TagsRepository;
  readonly readingPositions: ReadingPositionsRepository;
  readonly layouts: WorkspaceLayoutsRepository;
  readonly externalReferences: ExternalReferencesRepository;
  readonly jobs: IndexingJobsRepository;
  readonly searchIndex: SearchIndexRepository;
  readonly library: LibraryRepository;
  readonly wantedPages: WantedPagesRepository;
  readonly settings: SettingsRepository;
  /** What the librarian produced, and what was decided about it. */
  readonly agentRuns: AgentRunsRepository;
  readonly entities: EntityResolver;

  constructor(
    readonly sqlite: SqliteDatabase,
    readonly clock: Clock = systemClock,
  ) {
    this.documents = new DocumentsRepository(sqlite, clock);
    this.revisions = new DocumentRevisionsRepository(sqlite, clock);
    this.files = new DocumentFilesRepository(sqlite, clock);
    this.chunks = new DocumentChunksRepository(sqlite);
    this.annotations = new AnnotationsRepository(sqlite, clock);
    this.notes = new NotesRepository(sqlite, clock);
    this.questions = new QuestionsRepository(sqlite, clock);
    this.journal = new JournalRepository(sqlite, clock);
    this.links = new LinksRepository(sqlite, clock);
    this.graph = new GraphRepository(sqlite);
    this.collections = new CollectionsRepository(sqlite, clock);
    this.tags = new TagsRepository(sqlite);
    this.readingPositions = new ReadingPositionsRepository(sqlite, clock);
    this.layouts = new WorkspaceLayoutsRepository(sqlite, clock);
    this.externalReferences = new ExternalReferencesRepository(sqlite, clock);
    this.jobs = new IndexingJobsRepository(sqlite, clock);
    this.searchIndex = new SearchIndexRepository(sqlite, clock);
    this.library = new LibraryRepository(sqlite, this.documents);
    this.wantedPages = new WantedPagesRepository(sqlite, clock);
    this.settings = new SettingsRepository(sqlite, clock);
    this.agentRuns = new AgentRunsRepository(sqlite, clock);
    this.entities = new EntityResolver(sqlite);
  }

  /** Run `fn` inside a transaction. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    return this.sqlite.transaction(fn)();
  }

  version(): number {
    return schemaVersion(this.sqlite);
  }

  close(): void {
    this.sqlite.close();
  }
}

/** Open (creating if necessary) and migrate the application database. */
export function openDatabase(options: OpenDatabaseOptions): {
  db: WikiReaderDatabase;
  migration: MigrationResult;
} {
  const sqlite = openSqlite(options);
  const migration =
    options.migrate === false
      ? { applied: [], version: schemaVersion(sqlite) }
      : runMigrations(sqlite, undefined, () => (options.clock ?? systemClock).now());
  return { db: new WikiReaderDatabase(sqlite, options.clock ?? systemClock), migration };
}
