/**
 * Migration 013 — where a highlight sits in the page, as a column.
 *
 * The focused view draws a file's highlights in reading order (`F02`), and reading order was
 * `page_index, created_at, id`. That is not reading order. `page_index` is `NULL` for every
 * markdown file and every saved web page — only a PDF anchor has a page — so on the corpus this
 * app is built around the ring fell back to *creation* order, which reorders itself the moment
 * someone marks paragraph nine before paragraph two. Worse, `created_at` has millisecond
 * resolution and ids carry a random suffix, so two highlights made in the same millisecond came
 * back in an arbitrary order that changed between runs.
 *
 * Every anchor kind already records `position.start`: offsets into the normalized text of the
 * page (`pdf`), of the snapshot (`html`) or of the document (`markdown`). It was only ever
 * inside the JSON. Projected here beside `page_index`, it makes `(page_index, text_start)` a
 * total, stable order that means what the view says it means — the order the page reads.
 *
 * Backfilled with `json_extract` rather than by rewriting rows from the application: the value
 * is already in `anchor_json` and the column is a projection of it, exactly as `page_index` is.
 */

export const MIGRATION_013_ANCHOR_TEXT_START = `
ALTER TABLE annotation_anchors ADD COLUMN text_start INTEGER;

UPDATE annotation_anchors
   SET text_start = json_extract(anchor_json, '$.position.start')
 WHERE text_start IS NULL;

CREATE INDEX annotation_anchors_reading_idx
    ON annotation_anchors(page_index, text_start);
`;
