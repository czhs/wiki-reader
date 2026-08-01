/**
 * The one control that takes a link away, wherever the link is being looked at (`H07`).
 *
 * Four surfaces draw an edge and none of them could do anything to one: the ledger, the
 * references panel, the wiki and a file's neighbourhood. A link made by mistake — the wrong row
 * clicked in a picker, a drag that landed on the disc next to the one meant — had no undoing
 * short of leaving the app, which made every gesture that *makes* a link (and milestone 7 adds
 * two) heavier than it needed to be.
 *
 * So: one button, drawn beside whatever sentence a surface already writes about the edge, and
 * one command behind it. Not a `link:delete` call per panel — `COMMAND_IDS.deleteLink` announces
 * through the same channel `link:create` does, so every open ledger, references list and map
 * redraws itself and no panel has to know about the others.
 *
 * The confirmation this does *not* have is deliberate. An edge is the cheapest thing in the app
 * to remake — two clicks — and nothing goes with it: the paper, the sentence and the notebook on
 * either end are untouched. Compare `question:delete`, which takes a notebook's journal and its
 * claims with it and is guarded twice.
 */
import { COMMAND_IDS } from '@wr/workbench';
import { useWorkspace } from './workspace.js';

export function UnlinkButton({
  linkId,
  testId,
  label = 'Take this link away',
}: {
  readonly linkId: string;
  readonly testId: string;
  /** What it says to a screen reader and on hover. The glyph is the same everywhere. */
  readonly label?: string;
}): JSX.Element {
  const { run } = useWorkspace();
  return (
    <button
      type="button"
      className="wr-unlink"
      data-testid={testId}
      data-link-id={linkId}
      aria-label={label}
      title={label}
      onClick={(event) => {
        // The row underneath is a navigation control on both list surfaces; deleting the link
        // must not also open the thing at its far end.
        event.stopPropagation();
        void run(COMMAND_IDS.deleteLink, { linkId });
      }}
    >
      ×
    </button>
  );
}
