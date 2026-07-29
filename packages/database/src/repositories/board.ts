import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { Clock } from '../clock.js';

/** Where one card sits on its board, in board coordinates. */
export interface CardPosition {
  readonly x: number;
  readonly y: number;
}

interface CardPositionRow {
  readonly link_id: string;
  readonly x: number;
  readonly y: number;
}

/**
 * Where the cards on a question's desk board were put.
 *
 * The card itself is the edge in `links`; this repository stores nothing but the arrangement,
 * and only for cards that have actually been moved. `positionsForQuestion` therefore returns
 * a *partial* map — a card missing from it has never been dragged, which is a different fact
 * from "it is at the origin" and the board draws it differently.
 *
 * The join is what keeps the position keyed to the board it belongs to: a link id is enough
 * to write a row, but reading is always scoped through the question that owns the edge, so a
 * hand-written row against somebody else's edge cannot surface on this page.
 */
export class BoardRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  /** Every *placed* card on the question's board, by link id. Unplaced cards are absent. */
  positionsForQuestion(questionId: string): Map<string, CardPosition> {
    const rows = this.db
      .prepare(
        `SELECT cp.link_id, cp.x, cp.y
           FROM card_positions cp
           JOIN links l ON l.id = cp.link_id
          WHERE l.source_type = 'question' AND l.source_id = ?`,
      )
      .all(questionId) as CardPositionRow[];
    return new Map(rows.map((row) => [row.link_id, { x: row.x, y: row.y }]));
  }

  position(linkId: string): CardPosition | null {
    const row = this.db.prepare('SELECT link_id, x, y FROM card_positions WHERE link_id = ?').get(
      linkId,
    ) as CardPositionRow | undefined;
    return row === undefined ? null : { x: row.x, y: row.y };
  }

  /**
   * Record where a card was dropped.
   *
   * Called on the *end* of a drag, never on render. The foreign key refuses a position for an
   * edge that does not exist, so a card can only be placed on a board it is actually on.
   */
  place(linkId: string, position: CardPosition): CardPosition {
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      throw new Error('board.place: a position must be two finite numbers');
    }
    this.db
      .prepare(
        `INSERT INTO card_positions (link_id, x, y, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(link_id) DO UPDATE SET x = excluded.x, y = excluded.y,
                                            updated_at = excluded.updated_at`,
      )
      .run(linkId, position.x, position.y, this.clock.now());
    return { x: position.x, y: position.y };
  }

  /** Forget where a card was, without taking it off the board. */
  clear(linkId: string): boolean {
    return this.db.prepare('DELETE FROM card_positions WHERE link_id = ?').run(linkId).changes > 0;
  }
}
