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
 */
import { useCallback, useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { EmptyState, ErrorState, ListRow } from '@wr/shared-ui';
import { describeLocation } from '@wr/document-model';
import { DocumentIdSchema, type DocumentLedgerEntry } from '@wr/shared-types';
import { COMMAND_IDS, linkTypeLabel, type PanelDescriptor } from '@wr/workbench';
import { call, describeError, subscribe } from './ipc.js';
import { useWorkspace, useWorkspaceState } from './workspace.js';

/** As many rows as the page will ask for. Well under the channel's ceiling. */
const LEDGER_LIMIT = 400;

/** What a row says beside the other end: the relationship, then where it lands. */
function describeEdge(entry: DocumentLedgerEntry): string {
  const { link } = entry;
  const relationship =
    link.direction === 'outgoing' ? linkTypeLabel(link.type) : `${linkTypeLabel(link.type)} this`;
  const where = describeLocation(link.otherLocation);
  return where === '' ? relationship : `${relationship} · ${where}`;
}

const quoted = (text: string): string =>
  text.length <= 70 ? `“${text}”` : `“${text.slice(0, 69)}…”`;

export function LedgerPanelBody({ documentId }: { readonly documentId: string }): JSX.Element {
  const { host, run } = useWorkspace();
  const state = useWorkspaceState();
  const [entries, setEntries] = useState<readonly DocumentLedgerEntry[] | null>(null);
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

  // Grouped by the highlight the edges hang off, in the order the ledger returned them, so a
  // paper with four marked sentences reads as four accounts rather than as one flat pile.
  const byHighlight = new Map<string, { label: string; rows: DocumentLedgerEntry[] }>();
  for (const entry of onHighlights) {
    const group = byHighlight.get(entry.near.entityId) ?? {
      label: entry.near.label,
      rows: [],
    };
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

      {entries.length === 0 && (
        <EmptyState
          message="Nothing is linked to this file yet."
          testId="ledger-empty"
        />
      )}

      {onFile.length > 0 && (
        <section className="wr-ledger__section" data-testid="ledger-on-file">
          <h3 className="wr-ledger__heading">On this file</h3>
          <div className="wr-list">
            {onFile.map((entry) => (
              <ListRow
                key={entry.link.id}
                primary={entry.link.otherTitle}
                secondary={entry.link.excerpt}
                meta={describeEdge(entry)}
                testId={`ledger-row-${entry.link.id}`}
                onActivate={() => openRow(entry)}
              />
            ))}
          </div>
        </section>
      )}

      {[...byHighlight.entries()].map(([annotationId, group]) => (
        <section
          className="wr-ledger__section"
          key={annotationId}
          data-testid={`ledger-on-highlight-${annotationId}`}
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
          <div className="wr-list">
            {group.rows.map((entry) => (
              <ListRow
                key={entry.link.id}
                primary={entry.link.otherTitle}
                secondary={entry.link.excerpt}
                meta={describeEdge(entry)}
                testId={`ledger-row-${entry.link.id}`}
                onActivate={() => openRow(entry)}
              />
            ))}
          </div>
        </section>
      ))}

      {elsewhere.length > 0 && (
        <section className="wr-ledger__section" data-testid="ledger-on-passages">
          <h3 className="wr-ledger__heading">On passages of this file</h3>
          <div className="wr-list">
            {elsewhere.map((entry) => (
              <ListRow
                key={entry.link.id}
                primary={entry.link.otherTitle}
                secondary={entry.near.label}
                meta={describeEdge(entry)}
                testId={`ledger-row-${entry.link.id}`}
                onActivate={() => openRow(entry)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export function ledgerDescriptorFrom(descriptor: PanelDescriptor | null): string | null {
  if (descriptor === null || descriptor.kind !== 'ledger') return null;
  return descriptor.documentId;
}

export function LedgerPanel({ params }: IDockviewPanelProps<{ panelId: string }>): JSX.Element {
  const state = useWorkspaceState();
  // Read from the descriptor, not from panel state: the ledger is re-seated onto another file
  // the same way the focused view is, and this is how that change arrives.
  const documentId = ledgerDescriptorFrom(state.panels[params.panelId] ?? null);
  if (documentId === null) {
    return <EmptyState message="Open a file to see its links." testId="ledger-empty" />;
  }
  return <LedgerPanelBody documentId={documentId} />;
}
