/**
 * The librarian's panel: what it would send, whether it may, and what it has proposed.
 *
 * The order on screen is the order of the decision. The disclosure is first and is not behind
 * a disclosure triangle, because the switch below it is the only thing on this panel that
 * changes what leaves the machine, and a person should not have to go looking for the terms
 * before agreeing to them. The main process refuses to enable without the acknowledgement
 * anyway (`A03`) — this is the same rule stated where it can be read rather than only enforced.
 *
 * Proposals are the rest of the panel. Each one is a claim with its citations attached, and
 * the two buttons are the whole interface to `LibrarianService`: accepting writes it into the
 * workspace and makes it a document, rejecting writes nothing at all. A citation is a button
 * rather than text because it is a place — clicking it opens the source where the claim came
 * from (`A10`).
 */
import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState } from '@wr/shared-ui';
import type {
  AgentDisclosure,
  AgentProposal,
  AgentStatus,
  LibrarianCapabilityId,
  ProposalCitation,
} from '@wr/shared-types';
import { call, describeError, subscribe } from './ipc.js';
import { useWorkspace } from './workspace.js';

export function LibrarianView({ testId }: { readonly testId?: string }): JSX.Element {
  const { store, workbench } = useWorkspace();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [disclosure, setDisclosure] = useState<AgentDisclosure | null>(null);
  const [proposals, setProposals] = useState<readonly AgentProposal[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const report = useCallback(
    (failure: unknown) => {
      store.setStatus(describeError(failure).message, 'error');
    },
    [store],
  );

  /**
   * Everything the panel shows, in one round trip each.
   *
   * All three are answered whether or not agents are enabled, and none of them starts
   * anything: the panel being open is not a decision to run.
   */
  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextDisclosure, listed] = await Promise.all([
        call('agent:status', {}),
        call('agent:disclosure', {}),
        call('agent:listProposals', { status: 'pending', limit: 100 }),
      ]);
      setStatus(nextStatus);
      setDisclosure(nextDisclosure);
      setProposals(listed.proposals);
      setError(null);
    } catch (failure) {
      setError(describeError(failure).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A pass takes minutes. The stream is the difference between watching it work and staring
  // at a button that might have done nothing.
  useEffect(
    () =>
      subscribe('agent:progress', (event) => {
        setProgress(event.phase === 'finished' ? null : event.detail);
        if (event.phase === 'finished') void refresh();
      }),
    [refresh],
  );

  const enable = useCallback(
    async (next: boolean) => {
      try {
        // The acknowledgement is sent with the request that needs it, and only when turning
        // it on: what is being agreed to is a run, not a preference.
        setStatus(await call('agent:enable', { enabled: next, acknowledgeDisclosure: next }));
        await refresh();
      } catch (failure) {
        report(failure);
      }
    },
    [refresh, report],
  );

  const toggleCapability = useCallback(
    async (capability: LibrarianCapabilityId, on: boolean) => {
      if (status === null) return;
      const next = on
        ? [...new Set([...status.capabilities, capability])]
        : status.capabilities.filter((each) => each !== capability);
      try {
        setStatus(await call('agent:setCapabilities', { capabilities: next }));
        await refresh();
      } catch (failure) {
        report(failure);
      }
    },
    [refresh, report, status],
  );

  const runPass = useCallback(async () => {
    setProgress('Starting…');
    try {
      const outcome = await call('agent:run', {});
      store.setStatus(
        outcome.proposals === 0
          ? 'The librarian found nothing worth proposing.'
          : `The librarian proposed ${String(outcome.proposals)}.`,
      );
    } catch (failure) {
      report(failure);
    } finally {
      setProgress(null);
      await refresh();
    }
  }, [refresh, report, store]);

  const decide = useCallback(
    async (proposal: AgentProposal, verdict: 'accept' | 'reject') => {
      try {
        if (verdict === 'accept') await call('agent:accept', { proposalId: proposal.id });
        else await call('agent:reject', { proposalId: proposal.id });
        store.setStatus(
          verdict === 'accept'
            ? `Accepted “${proposal.title}” into the librarian's workspace.`
            : `Rejected “${proposal.title}”. Nothing was written.`,
        );
        await refresh();
      } catch (failure) {
        report(failure);
      }
    },
    [refresh, report, store],
  );

  const open = useCallback(
    (citation: ProposalCitation) => {
      void workbench.navigate(
        {
          entityType: citation.entityType,
          entityId: citation.entityId,
          ...(citation.location === null ? {} : { location: citation.location }),
        },
        'current',
      );
    },
    [workbench],
  );

  if (error !== null) return <ErrorState message={error} testId={testId} />;
  if (status === null || disclosure === null) {
    return <EmptyState message="Asking whether agents are on…" testId={testId} />;
  }

  return (
    <div className="wr-sidebar-body" data-testid={testId}>
      <Disclosure disclosure={disclosure} />

      <div className="wr-agent__switch" data-testid="agent-switch" data-enabled={String(status.enabled)}>
        <button
          type="button"
          className="wr-button"
          data-testid="agent-enable"
          aria-pressed={status.enabled}
          onClick={() => void enable(!status.enabled)}
        >
          {status.enabled
            ? 'Turn the librarian off'
            : status.disclosureAcknowledged
              ? 'Turn the librarian on'
              : 'I have read this — turn the librarian on'}
        </button>
        <button
          type="button"
          className="wr-button"
          data-testid="agent-run"
          disabled={!status.enabled || status.running}
          onClick={() => void runPass()}
        >
          {status.running ? 'Running…' : 'Run a pass now'}
        </button>
      </div>

      {progress !== null && (
        <p className="wr-agent__progress" data-testid="agent-progress">
          {progress}
        </p>
      )}

      <h3 className="wr-list__section">What it may do</h3>
      <ul className="wr-agent__capabilities" data-testid="agent-capabilities">
        {disclosure.capabilities.map((capability) => (
          <li key={capability.id}>
            <label className="wr-agent__capability">
              <input
                type="checkbox"
                data-testid={`agent-capability-${capability.id}`}
                checked={status.capabilities.includes(capability.id)}
                onChange={(event) => void toggleCapability(capability.id, event.target.checked)}
              />
              <span>{capability.line}</span>
              {capability.core && <span className="wr-list__section-count">core</span>}
            </label>
          </li>
        ))}
      </ul>

      <h3 className="wr-list__section">
        Proposals
        <span className="wr-list__section-count" data-testid="agent-pending-count">
          {String(status.pendingProposals)}
        </span>
      </h3>
      {proposals.length === 0 ? (
        <p className="wr-agent__empty" data-testid="agent-no-proposals">
          Nothing is waiting on you.
        </p>
      ) : (
        <ul className="wr-agent__proposals" data-testid="agent-proposals">
          {proposals.map((proposal) => (
            <li key={proposal.id} className="wr-agent__proposal" data-testid={`proposal-${proposal.id}`}>
              <h4 className="wr-agent__proposal-title" data-testid={`proposal-title-${proposal.id}`}>
                {proposal.title}
              </h4>
              <span className="wr-agent__kind">{proposal.kind}</span>
              <p className="wr-agent__proposal-body">{proposal.body}</p>
              {proposal.citations.length > 0 && (
                <ul className="wr-agent__citations">
                  {proposal.citations.map((citation) => (
                    <li key={`${citation.entityType}:${citation.entityId}`}>
                      <button
                        type="button"
                        className="wr-link-button"
                        data-testid={`citation-${citation.entityId}`}
                        onClick={() => open(citation)}
                      >
                        {citation.title}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="wr-agent__verdict">
                <button
                  type="button"
                  className="wr-button"
                  data-testid={`accept-${proposal.id}`}
                  onClick={() => void decide(proposal, 'accept')}
                >
                  Accept
                </button>
                <button
                  type="button"
                  className="wr-button"
                  data-testid={`reject-${proposal.id}`}
                  onClick={() => void decide(proposal, 'reject')}
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * What a run would send, where, and on whose account.
 *
 * The counts come from the main process, which reads them off the database, so this cannot
 * describe a smaller wiki than the one that would actually be written out.
 */
function Disclosure({ disclosure }: { readonly disclosure: AgentDisclosure }): JSX.Element {
  return (
    <section className="wr-agent__disclosure" data-testid="agent-disclosure">
      <p className="wr-agent__headline" data-testid="agent-disclosure-headline">
        {disclosure.headline}
      </p>
      <p data-testid="agent-disclosure-destination">{disclosure.destination}</p>
      <p data-testid="agent-disclosure-credentials">{disclosure.credentials}</p>
      <h3 className="wr-list__section">What would be sent</h3>
      <ul className="wr-agent__sends" data-testid="agent-disclosure-sends">
        {disclosure.sends.map((item) => (
          <li key={item.what}>
            <span>{item.what}</span>
            <span className="wr-list__section-count">{String(item.count)}</span>
          </li>
        ))}
      </ul>
      <h3 className="wr-list__section">What would not</h3>
      <ul className="wr-agent__withholds" data-testid="agent-disclosure-withholds">
        {disclosure.withholds.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="wr-agent__tools" data-testid="agent-disclosure-tools">
        {`Tools it is given: ${disclosure.tools.join(', ')}.`}
      </p>
    </section>
  );
}
