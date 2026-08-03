/**
 * A `WorkbenchHost` that answers nothing.
 *
 * The menus (`R01`) and the guide (`O01`) are both *readings of the registries*, and the point
 * of the tests that use this is that neither can get an answer from anywhere else. A host that
 * returned something would let a menu item or a guide chapter pass on a fact the running app
 * would not have supplied.
 *
 * It is here rather than in each spec because it is a list of every method on the interface:
 * two copies meant that adding a method to `WorkbenchHost` broke two files identically, and
 * that the two could drift into disagreeing about what "answers nothing" means. Tests that
 * want a host that *does* something record their own — see `workbench.test.ts`.
 */
import type { Link, NavigationLocation, ResolvedLink } from '@wr/shared-types';
import type { EntityRef } from '../../src/entity-links.js';
import type { PanelDescriptor } from '../../src/layout.js';
import {
  emptyWorkspaceSnapshot,
  type OpenPlan,
  type WorkspaceSnapshot,
} from '../../src/panel-targets.js';
import type {
  BlockActionRequest,
  EntityLinkRequest,
  WorkbenchHost,
} from '../../src/workbench.js';

export class SilentHost implements WorkbenchHost {
  getWorkspace(): WorkspaceSnapshot {
    return emptyWorkspaceSnapshot();
  }
  applyPlan(_plan: OpenPlan): void {}
  getActiveEntity(): EntityRef | null {
    return null;
  }
  getLinkUnderCursor(): EntityRef | null {
    return null;
  }
  describeEntity(_entity: EntityRef): PanelDescriptor | null {
    return null;
  }
  getLinks(): readonly Link[] {
    return [];
  }
  resolveLinks(): readonly ResolvedLink[] {
    return [];
  }
  closePanel(_panelId: string | null): void {}
  closeGroup(_groupId: string | null): void {}
  showReferences(): void {}
  stepReference(): void {}
  showPeek(): void {}
  revealInLibrary(): void {}
  togglePanel(): void {}
  copyToClipboard(): void {}
  showCommands(): void {}
  showFiles(): void {}
  notebookInHand(): Promise<string | null> {
    return Promise.resolve(null);
  }
  promptEntityLink(): void {}
  createEntityLink(_request: EntityLinkRequest): Promise<Link | null> {
    return Promise.resolve(null);
  }
  deleteEntityLink(_linkId: string): Promise<boolean> {
    return Promise.resolve(false);
  }
  promptSendToNotebook(): void {}
  sendToNotebook(): Promise<boolean> {
    return Promise.resolve(false);
  }
  promptJournal(_questionId: string): void {}
  createNoteFrom(): Promise<string | null> {
    return Promise.resolve(null);
  }
  runBlockAction(_request: BlockActionRequest): void {}
  currentNavigationLocation(): NavigationLocation | null {
    return null;
  }
}
