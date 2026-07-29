/**
 * @wr/database — SQLite persistence for wiki-reader.
 *
 * MAIN PROCESS ONLY. Renderer packages must reach this through IPC; ESLint and
 * scripts/verify_completion.py both enforce that boundary.
 */

export * from './clock.js';
export * from './connection.js';
export * from './migrator.js';
export * from './migrations/index.js';
export * from './mappers.js';
export * from './entity-resolver.js';
export * from './database.js';

export * from './repositories/documents.js';
export * from './repositories/annotations.js';
export * from './repositories/notes.js';
export * from './repositories/links.js';
export * from './repositories/graph.js';
export * from './repositories/graph-view.js';
export * from './repositories/organisation.js';
export * from './repositories/session.js';
export * from './repositories/external-references.js';
export * from './repositories/indexing-jobs.js';
export * from './repositories/search-index.js';
export * from './repositories/library.js';
export * from './repositories/wanted-pages.js';
export * from './repositories/settings.js';
export * from './repositories/agents.js';
export * from './repositories/questions.js';
export * from './repositories/hypotheses.js';
export * from './repositories/board.js';
export * from './repositories/journal.js';
