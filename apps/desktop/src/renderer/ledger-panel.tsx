/**
 * A file's ledger: everything this paper is connected to, and how (criterion H03).
 *
 * The references panel answers "what touches *this entity*". A researcher looking at a paper
 * does not think in entities: the sentence they marked in it is part of the paper as far as
 * they are concerned, and a page that showed the paper's own links while quietly omitting the
 * ones hanging off its highlights would be an account with half the entries missing. So the
 * question this page asks is bounded by the *file* — `link:findForDocument` — and every row
 * says which end of it is inside, because that is the part the reader cannot infer.
 *
 * It is also where linking starts. "The file itself is linkable from it" is the criterion's
 * last clause and it is not decoration: the ledger is the one place that shows what a paper is
 * already connected to, which is exactly when you notice what it should be connected to. Both
 * gestures go through the same command the reader's strip uses — a ledger that wrote its own
 * edge would be a second way to make a link, and the second way is the one that drifts.
 *
 * Which is why the highlights come from the *file* rather than from its edges (`E03`). Grouping
 * the entries by their near end could only ever show a sentence something had already been said
 * about, so "Link this highlight…" existed exactly where linking had already happened. The
 * groups are now one per marked sentence, in the order they were marked, and an empty one is
 * the useful case rather than the missing one.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ellipsize } from '@wr/document-model';
import { EmptyState, ErrorState, ListRow } from '@wr/shared-ui';
import {
  DocumentIdSchema,
  type DocumentLedgerEntry,
  type DocumentLedgerHighlight,
} from '@wr/shared-types';
import { COMMAND_IDS, describeResolvedLink } from '@wr/workbench';
import { call, describeError, subscribe } from './ipc.js';
import { UnlinkButton } from './link-actions.js';
import {
  usePanelDescriptor,
  useWorkspace,
  useWorkspaceState,
  type DockPanelProps,
} from './workspace.js';

/** As many rows as the page will ask for. Well under the channel's ceiling. */
const LEDGER_LIMIT = 400;

/** What a row says beside the other end: the relationship, then where it lands. */
const describeEdge = (entry: DocumentLedgerEntry): string => describeResolvedLink(entry.link);

/** As much of a marked sentence as a ledger row shows, in quotation marks. */
const QUOTE_IN_ROW = 70;

const quoted = (text: string): string => `“${ellipsize(text, QUOTE_IN_ROW)}”`;

/** One account of links, as the ledger prints them. */
function LedgerRows({
  entries,
  secondaryOf,
  onOpen,
}: {
  readonly entries: readonly DocumentLedgerEntry[];
  /**
   * What the row's second line says — the excerpt, or which passage the link hangs off.
   *
   * `ReactNode` rather than `string`, because an excerpt is legitimately null and `ListRow`
   * distinguishes that (an empty second line) from no second line at all.
   */
  readonly secondaryOf: (entry: DocumentLedgerEntry) => ReactNode;
  readonly onOpen: (entry: DocumentLedgerEntry) => void;
}): JSX.Element {
  return (
    <div className="wr-list">
      {entries.map((entry) => (
        <ListRow
          key={entry.link.id}
          primary={entry.link.otherTitle}
          secondary={secondaryOf(entry)}
          meta={describeEdge(entry)}
          testId={`ledger-row-${entry.link.id}`}
          // The account of what this file is connected to is where a wrong connection is
          // noticed, so it is where taking one away belongs (`H07`).
          action={
            <UnlinkButton
              linkId={entry.link.id}
              testId={`ledger-unlink-${entry.link.id}`}
              label={`Take away the link to ${entry.link.otherTitle}`}
            />
          }
          onActivate={() => {
            onOpen(entry);
          }}
        />
      ))}
    </div>
  );
}

function LedgerPanelBody({ documentId }: { readonly documentId: string }): JSX.Element {
  const { host, run } = useWorkspace();
  const state = useWorkspaceState();
  const [entries, setEntries] = useState<readonly DocumentLedgerEntry[] | null>(null);
  const [highlights, setHighlights] = useState<readonly DocumentLedgerHighlight[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((): Promise<void> => {
    const parsed = DocumentIdSchema.safeParse(documentId);
    if (!parsed.success) {
      setError(`Not a file with a ledger: ${documentId}`);
      return Promise.resolve();
    }
    return call('link:findForDocument', { documentId: parsed.data, limit: LEDGER_LIMIT })
      .then((answer) => {
        setEntries(answer.entries);
        setHighlights(answer.highlights);
        setError(null);
      })
      .catch((failure: unknown) => {
        setError(describeError(failure).message);
      });
  }, [documentId]);

  useEffect(() => {
    void load();
    // A link made while this is open belongs in it without reopening the page.
    return subscribe('library:changed', () => {
      void load();
    });
  }, [load]);

  if (error !== null) return <ErrorState message={error} testId="ledger-panel-error" />;
  if (entries === null) return <EmptyState message="Reading the ledger…" testId="ledger-loading" />;

  const title = state.documentTitles[documentId] ?? 'This file';
  const onFile = entries.filter((entry) => entry.near.entityType === 'document');
  const onHighlights = entries.filter((entry) => entry.near.entityType === 'annotation');
  const elsewhere = entries.filter(
    (entry) => entry.near.entityType !== 'document' && entry.near.entityType !== 'annotation',
  );

  // One group per marked sentence, in the order they were marked — seeded from the file's own
  // highlights so that a sentence with nothing said about it yet is a group with no rows rather
  // than a group that does not exist (`E03`). The edges are then dropped into their group.
  const byHighlight = new Map<string, { label: string; rows: DocumentLedgerEntry[] }>();
  for (const highlight of highlights) {
    byHighlight.set(highlight.annotationId, { label: highlight.label, rows: [] });
  }
  for (const entry of onHighlights) {
    const group = byHighlight.get(entry.near.entityId) ?? { label: entry.near.label, rows: [] };
    group.rows.push(entry);
    byHighlight.set(entry.near.entityId, group);
  }

  const openRow = (entry: DocumentLedgerEntry): void => {
    void host.openReference(entry.link);
  };

  return (
    <div
      className="wr-ledger"
      data-testid="ledger-panel"
      data-document-id={documentId}
      data-entry-count={String(entries.length)}
      data-on-file={String(onFile.length)}
      data-on-highlights={String(onHighlights.length)}
      data-highlight-count={String(byHighlight.size)}
    >
      <header className="wr-ledger__header">
        <span className="wr-ledger__title" data-testid="ledger-title">
          {title}
        </span>
        <span className="wr-ledger__count" data-testid="ledger-count">
          {entries.length === 1 ? '1 link' : `${String(entries.length)} links`}
        </span>
        {/* The file itself, linkable from the page that shows what it is already linked to. */}
        <button
          type="button"
          className="wr-button"
          data-testid="ledger-link-file"
          onClick={() =>
            void run(COMMAND_IDS.linkToDocument, {
              sourceId: documentId,
              sourceType: 'document',
            })
          }
        >
          Link this file…
        </button>
      </header>

      {entries.length === 0 && byHighlight.size === 0 && (
        <EmptyState
          message="Nothing is linked to this file yet."
          testId="ledger-empty"
        />
      )}

      {onFile.length > 0 && (
        <section className="wr-ledger__section" data-testid="ledger-on-file">
          <h3 className="wr-ledger__heading">On this file</h3>
          <LedgerRows
            entries={onFile}
            secondaryOf={(entry) => entry.link.excerpt}
            onOpen={openRow}
          />
        </section>
      )}

      {byHighlight.size > 0 && (
        <h3 className="wr-ledger__heading" data-testid="ledger-highlights-heading">
          Marked in this file
          <span className="wr-list__section-count">{byHighlight.size}</span>
        </h3>
      )}

      {[...byHighlight.entries()].map(([annotationId, group]) => (
        <section
          className="wr-ledger__section"
          key={annotationId}
          data-testid={`ledger-on-highlight-${annotationId}`}
          data-link-count={String(group.rows.length)}
        >
          <h3 className="wr-ledger__heading wr-ledger__heading--quote">
            {quoted(group.label)}
            <button
              type="button"
              className="wr-button"
              data-testid={`ledger-link-highlight-${annotationId}`}
              onClick={() =>
                void run(COMMAND_IDS.linkToDocument, {
                  sourceId: annotationId,
                  sourceType: 'annotation',
                  documentId,
                })
              }
            >
              Link this highlight…
            </button>
          </h3>
          {/* Said plainly rather than left as a gap: an empty group is the one the researcher
              is being invited to do something about. */}
          {group.rows.length === 0 ? (
            <p
              className="wr-ledger__unlinked"
              data-testid={`ledger-unlinked-${annotationId}`}
            >
              Nothing said about this sentence yet.
            </p>
          ) : (
            <LedgerRows
              entries={group.rows}
              secondaryOf={(entry) => entry.link.excerpt}
              onOpen={openRow}
            />
          )}
        </section>
      ))}

      {elsewhere.length > 0 && (
        <section className="wr-ledger__section" data-testid="ledger-on-passages">
          <h3 className="wr-ledger__heading">On passages of this file</h3>
          <LedgerRows
            entries={elsewhere}
            secondaryOf={(entry) => entry.near.label}
            onOpen={openRow}
          />
        </section>
      )}
    </div>
  );
}

export function LedgerPanel({ params }: DockPanelProps): JSX.Element {
  const documentId = usePanelDescriptor(params.panelId, 'ledger')?.documentId ?? null;
  if (documentId === null) {
    return <EmptyState message="Open a file to see its links." testId="ledger-empty" />;
  }
  return <LedgerPanelBody documentId={documentId} />;
}
