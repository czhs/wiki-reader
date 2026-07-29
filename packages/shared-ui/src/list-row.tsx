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
  /**
   * A control that acts on the row without opening it — removing it from the library, putting
   * it back. Rendered *beside* the row rather than inside it: the row is a `button`, and a
   * button inside a button is invalid markup that browsers repair by moving it out, at which
   * point it stops being clickable where it appears to be.
   */
  readonly action?: ReactNode;
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
  action,
}: ListRowProps): JSX.Element {
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if ((event.key === 'Enter' || event.key === ' ') && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onActivateToSide?.();
    }
  };

  const row = (
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

  if (action === undefined) return row;
  return (
    <div className="wr-row-group">
      {row}
      <span className="wr-row-group__action">{action}</span>
    </div>
  );
}
