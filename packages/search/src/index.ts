/**
 * @wr/search — FTS5 chunking, query building, and result mapping.
 *
 * MAIN PROCESS ONLY: this package talks to SQLite. The renderer reaches it through the
 * `search:query` IPC channel.
 */

export * from './chunking.js';
export * from './query.js';
export * from './indexer.js';
export * from './search-service.js';
