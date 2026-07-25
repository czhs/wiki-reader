import type { ReactNode } from 'react';
import { classNames } from './class-names.js';

export interface PanelProps {
  /** Shown in the panel's own header. Dockview draws the tab; this is the content title. */
  readonly title?: ReactNode;
  readonly toolbar?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  /** Stable hook for tests and for `revealInLibrary`-style focus moves. */
  readonly testId?: string;
}

/**
 * Panel chrome: an optional header that does not scroll, above a body that does.
 *
 * Every panel needs exactly this and nothing more elaborate — Dockview already owns the
 * tab, the border, and the resize behaviour.
 */
export function Panel({ title, toolbar, children, className, testId }: PanelProps): JSX.Element {
  const hasHeader = title !== undefined || toolbar !== undefined;
  return (
    <section className={classNames('wr-panel', className)} data-testid={testId}>
      {hasHeader && (
        <header className="wr-panel__header">
          {title !== undefined && <h2 className="wr-panel__title">{title}</h2>}
          {toolbar !== undefined && <div className="wr-panel__toolbar">{toolbar}</div>}
        </header>
      )}
      <div className="wr-panel__body">{children}</div>
    </section>
  );
}

export function PanelToolbar({ children }: { readonly children: ReactNode }): JSX.Element {
  return <div className="wr-panel__toolbar-group">{children}</div>;
}
