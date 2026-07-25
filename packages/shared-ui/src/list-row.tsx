import type { KeyboardEvent, ReactNode } from 'react';
import { classNames } from './class-names.js';

export interface ListRowProps {
  readonly primary: ReactNode;
  readonly secondary?: ReactNode;
  readonly meta?: ReactNode;
  readonly selected?: boolean;
  readonly onActivate?: () => void;
  /** Distinct from activation: a click that opens beside rather than in place. */
  readonly onActivateToSide?: () => void;
  readonly testId?: string;
  readonly title?: string;
}

/**
 * One selectable row in a list panel.
 *
 * A `button` rather than a styled `div` so that focus, Enter/Space activation and screen
 * reader semantics come from the platform instead of being reimplemented per panel.
 * Cmd/Ctrl-click opens to the side, matching the workbench's `openToSide` command.
 */
export function ListRow({
  primary,
  secondary,
  meta,
  selected = false,
  onActivate,
  onActivateToSide,
  testId,
  title,
}: ListRowProps): JSX.Element {
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if ((event.key === 'Enter' || event.key === ' ') && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onActivateToSide?.();
    }
  };

  return (
    <button
      type="button"
      className={classNames('wr-row', selected && 'wr-row--selected')}
      aria-current={selected ? 'true' : undefined}
      data-testid={testId}
      title={title}
      onKeyDown={handleKeyDown}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey) onActivateToSide?.();
        else onActivate?.();
      }}
    >
      <span className="wr-row__primary">{primary}</span>
      {secondary !== undefined && <span className="wr-row__secondary">{secondary}</span>}
      {meta !== undefined && <span className="wr-row__meta">{meta}</span>}
    </button>
  );
}
