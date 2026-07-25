import type { ReactNode } from 'react';

export interface EmptyStateProps {
  readonly message: ReactNode;
  /** What the user can do about it. Omitted when there is nothing useful to suggest. */
  readonly hint?: ReactNode;
  /** Explicitly `| undefined`: panels forward an optional id straight through. */
  readonly testId?: string | undefined;
}

export function EmptyState({ message, hint, testId }: EmptyStateProps): JSX.Element {
  return (
    <div className="wr-state" data-testid={testId}>
      <p className="wr-state__message">{message}</p>
      {hint !== undefined && <p className="wr-state__hint">{hint}</p>}
    </div>
  );
}

export interface ErrorStateProps {
  readonly message: ReactNode;
  /** The concrete action that would fix it, straight from the IPC error's `remedy`. */
  readonly remedy?: ReactNode;
  readonly onRetry?: () => void;
  /** Explicitly `| undefined`: panels forward an optional id straight through. */
  readonly testId?: string | undefined;
}

/**
 * A failure the user can see and act on.
 *
 * Failures are never rendered as an empty list: "no results" and "the query failed" look
 * identical that way, and the second one is the user's cue to do something.
 */
export function ErrorState({ message, remedy, onRetry, testId }: ErrorStateProps): JSX.Element {
  return (
    <div className="wr-state wr-state--error" role="alert" data-testid={testId}>
      <p className="wr-state__message">{message}</p>
      {remedy !== undefined && <p className="wr-state__hint">{remedy}</p>}
      {onRetry !== undefined && (
        <button type="button" className="wr-button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
