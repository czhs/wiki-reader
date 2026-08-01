import { MIGRATION_001_INITIAL } from './001_initial.js';
import { MIGRATION_002_MARKDOWN } from './002_markdown.js';
import { MIGRATION_003_SETTINGS } from './003_settings.js';
import { MIGRATION_004_QUESTIONS } from './004_questions.js';
import { MIGRATION_005_JOURNAL } from './005_journal.js';
import { MIGRATION_006_AGENTS } from './006_agents.js';
import { MIGRATION_007_NOTEBOOKS } from './007_notebooks.js';
import { MIGRATION_008_DESK_BOARD } from './008_desk_board.js';
import { MIGRATION_009_LIBRARY_CURATION } from './009_library_curation.js';
import { MIGRATION_010_GRAPH_NODE_NAMES } from './010_graph_node_names.js';
import { MIGRATION_011_GRAPH_NODE_ICONS } from './011_graph_node_icons.js';
import { MIGRATION_012_NOTEBOOK_JOURNALS } from './012_notebook_journals.js';
import { MIGRATION_013_ANCHOR_TEXT_START } from './013_anchor_text_start.js';
import { MIGRATION_014_DESK_RETIRED } from './014_desk_retired.js';

/**
 * A forward-only schema migration.
 *
 * Migrations are never edited once released: correcting the schema means adding a new
 * entry. The migrator records the checksum of every applied statement so an edited
 * migration is detected instead of silently diverging between machines.
 */
export interface Migration {
  /** Monotonically increasing, matches `PRAGMA user_version` after it is applied. */
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  { id: 1, name: '001_initial', sql: MIGRATION_001_INITIAL },
  { id: 2, name: '002_markdown', sql: MIGRATION_002_MARKDOWN },
  { id: 3, name: '003_settings', sql: MIGRATION_003_SETTINGS },
  { id: 4, name: '004_questions', sql: MIGRATION_004_QUESTIONS },
  { id: 5, name: '005_journal', sql: MIGRATION_005_JOURNAL },
  { id: 6, name: '006_agents', sql: MIGRATION_006_AGENTS },
  { id: 7, name: '007_notebooks', sql: MIGRATION_007_NOTEBOOKS },
  { id: 8, name: '008_desk_board', sql: MIGRATION_008_DESK_BOARD },
  { id: 9, name: '009_library_curation', sql: MIGRATION_009_LIBRARY_CURATION },
  { id: 10, name: '010_graph_node_names', sql: MIGRATION_010_GRAPH_NODE_NAMES },
  { id: 11, name: '011_graph_node_icons', sql: MIGRATION_011_GRAPH_NODE_ICONS },
  { id: 12, name: '012_notebook_journals', sql: MIGRATION_012_NOTEBOOK_JOURNALS },
  { id: 13, name: '013_anchor_text_start', sql: MIGRATION_013_ANCHOR_TEXT_START },
  { id: 14, name: '014_desk_retired', sql: MIGRATION_014_DESK_RETIRED },
];

/** The schema version a freshly migrated database reports. */
export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (max, migration) => (migration.id > max ? migration.id : max),
  0,
);
