import type { ReactNode } from 'react';
import { classNames } from './class-names.js';

export interface BadgeProps {
  readonly children: ReactNode;
  readonly tone?: 'neutral' | 'accent' | 'warning';
  readonly title?: string;
}

export function Badge({ children, tone = 'neutral', title }: BadgeProps): JSX.Element {
  return (
    <span className={classNames('wr-badge', `wr-badge--${tone}`)} title={title}>
      {children}
    </span>
  );
}
