/**
 * @wr/shared-ui — the small set of primitives every panel shares.
 *
 * Deliberately not a design system. Panels are the interesting part of this application;
 * a component library would be a second thing to maintain and would not make any panel
 * easier to write. What lives here is what would otherwise be copy-pasted into five panels:
 * the panel chrome, a selectable row, and the two placeholder states every list needs.
 */
export { Panel, PanelToolbar } from './panel.js';
export { ListRow } from './list-row.js';
export { EmptyState, ErrorState } from './states.js';
export { Badge } from './badge.js';
export { classNames } from './class-names.js';
