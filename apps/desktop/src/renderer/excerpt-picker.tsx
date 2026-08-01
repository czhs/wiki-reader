/**
 * Choosing a highlight to quote into a notebook page (criterion S03).
 *
 * The gesture the researcher asked for is "link — inserting the text — in a notebook
 * directly", so this is reached from the page they are writing on rather than from the reader
 * they were reading in. Two steps, the shape the link picker already uses: the file, then one
 * of its marked sentences. Bounded on purpose — a flat list of every highlight in a library is
 * a list nobody can find anything in, and `annotation:listByDocument` is the query that
 * exists.
 *
 * It answers with the markdown, not with an insertion: what an excerpt *is* belongs to
 * `excerptMarkdown` in the document model, and where it goes belongs to the page.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { excerptMarkdown, shorten } from '@wr/document-model';
import { DocumentIdSchema, type AnnotationWithAnchor, type LibraryItem } from '@wr/shared-types';
import { call } from './ipc.js';
import { Overlay, useCloseOnEscape } from './overlays.js';
import { useReportFailure } from './workspace.js';

/** What a chosen highlight becomes: the edge to create, and the block to write. */
export interface ChosenExcerpt {
  readonly annotationId: string;
  readonly markdown: string;
}

/** One line of a quote in the list — enough to recognise the sentence, never the whole page. */
const PREVIEW = 160;

const preview = (text: string): string => shorten(text, PREVIEW);

export function ExcerptPicker({
  onChoose,
  onDismiss,
}: {
  readonly onChoose: (excerpt: ChosenExcerpt) => void;
  readonly onDismiss: () => void;
}): JSX.Element {
  const [items, setItems] = useState<readonly LibraryItem[] | null>(null);
  const [filter, setFilter] = useState('');
  const [chosen, setChosen] = useState<LibraryItem | null>(null);
  const [highlights, setHighlights] = useState<readonly AnnotationWithAnchor[] | null>(null);

  useCloseOnEscape(true, onDismiss);

  const report = useReportFailure();

  useEffect(() => {
    void (async () => {
      try {
        const result = await call('library:listDocuments', { limit: 200, offset: 0 });
        setItems(result.items);
      } catch (failure) {
        report(failure);
        setItems([]);
      }
    })();
  }, [report]);

  const open = useCallback(
    async (item: LibraryItem) => {
      const parsed = DocumentIdSchema.safeParse(item.document.id);
      if (!parsed.success) return;
      setChosen(item);
      setHighlights(null);
      try {
        const result = await call('annotation:listByDocument', { documentId: parsed.data });
        setHighlights(result.annotations);
      } catch (failure) {
        report(failure);
        setHighlights([]);
      }
    },
    [report],
  );

  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = items ?? [];
    if (needle === '') return all.slice(0, 50);
    return all
      .filter((item) => item.document.title.toLowerCase().includes(needle))
      .slice(0, 50);
  }, [filter, items]);

  return (
    <Overlay name="excerpt-picker" onDismiss={onDismiss}>
      <div
        className="wr-picker"
        data-testid="excerpt-picker"
        role="dialog"
        aria-label="Quote a highlight into this page"
      >
        <h2 className="wr-picker__title">Quote a highlight</h2>
        {chosen === null ? (
          <>
            <input
              className="wr-input"
              type="text"
              autoFocus
              placeholder="Which file?"
              aria-label="Find the file the highlight is in"
              data-testid="excerpt-picker-filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <div className="wr-picker__list" data-testid="excerpt-picker-files">
              {items !== null && matches.length === 0 && (
                <p className="wr-picker__empty" data-testid="excerpt-picker-no-files">
                  Nothing in the library matches that.
                </p>
              )}
              {matches.map((item) => (
                <button
                  key={item.document.id}
                  type="button"
                  className="wr-picker__option"
                  data-testid={`excerpt-picker-file-${item.document.id}`}
                  onClick={() => void open(item)}
                >
                  {item.document.title}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <p className="wr-picker__chosen" data-testid="excerpt-picker-chosen">
              {chosen.document.title}
            </p>
            <div className="wr-picker__list" data-testid="excerpt-picker-highlights">
              {highlights !== null && highlights.length === 0 && (
                <p className="wr-picker__empty" data-testid="excerpt-picker-no-highlights">
                  Nothing is marked in that file yet.
                </p>
              )}
              {(highlights ?? []).map((annotation) => (
                <button
                  key={annotation.id}
                  type="button"
                  className="wr-picker__option"
                  data-testid={`excerpt-picker-highlight-${annotation.id}`}
                  onClick={() =>
                    onChoose({
                      annotationId: annotation.id,
                      markdown: excerptMarkdown({
                        annotationId: annotation.id,
                        selectedText: annotation.selectedText,
                        sourceTitle: chosen.document.title,
                      }),
                    })
                  }
                >
                  {preview(annotation.selectedText)}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="wr-button wr-button--quiet"
              data-testid="excerpt-picker-back"
              onClick={() => {
                setChosen(null);
                setHighlights(null);
              }}
            >
              ← another file
            </button>
          </>
        )}
      </div>
    </Overlay>
  );
}
