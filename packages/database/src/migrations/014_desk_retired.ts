/**
 * Migration 014 — the desk board is retired, and its positions go with it (criterion P06).
 *
 * `card_positions` held one thing: where a card had been dragged on a question's board. The
 * board is gone — what it showed were `question-references-…` edges, and those now appear as
 * blocks in the page's own markdown — so a coordinate in it is a fact about a surface that no
 * longer exists. Kept, it would be data outliving its feature: something a later reader has to
 * work out is dead, and something a later feature might half-revive.
 *
 * Nothing the researcher wrote is in here. The *cards* were the edges, and `links` is
 * untouched; a pass in the main process gives each of those edges a block on the page it
 * belongs to before this schema version is ever read. Migration 008 stays exactly as it was
 * written, because migrations are never edited — this is the entry that undoes it.
 */

export const MIGRATION_014_DESK_RETIRED = `
DROP TABLE IF EXISTS card_positions;
`;
