/**
 * Migration 008 — the desk board: where a question's cards were put.
 *
 * A card is not a new kind of thing. It is the edge that already exists between a question
 * and a paper or a highlight — `question-references-document`, written by `question:attach`
 * — drawn as a rectangle instead of as a row. That is why there is no `cards` table here: a
 * second table naming the same relationship would be a second mechanism to keep in step with
 * the graph, the reference query and the broken-link check, and the first thing to drift.
 *
 * What is genuinely new is *position*, and the rule this table exists to encode is that a
 * position is written **only once a card has been dragged**. A card the researcher has never
 * touched has no row at all, so opening a board arranges the untouched ones however the
 * current layout arranges them and re-arranges them freely later. Storing a default the
 * moment a card appears would record a decision nobody made, and then defend it forever —
 * the board would be unable to improve its own default without moving cards somebody thinks
 * they placed.
 *
 * `ON DELETE CASCADE` from `links` is the whole of the lifecycle: take the card off the board
 * by deleting the edge, and the position goes with it rather than lingering to reappear under
 * a later edge that happened to be minted with the same id.
 *
 * `x` and `y` are `REAL` and unbounded on purpose. They are board coordinates, not screen
 * ones — a clamp here would be this table having an opinion about the size of a window it
 * cannot see.
 */

export const MIGRATION_008_DESK_BOARD = `
CREATE TABLE card_positions (
  link_id    TEXT PRIMARY KEY REFERENCES links(id) ON DELETE CASCADE,
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  updated_at TEXT NOT NULL
);
`;
