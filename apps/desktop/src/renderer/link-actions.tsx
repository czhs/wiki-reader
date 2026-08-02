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
  refusal = null,
}: {
  readonly linkId: string;
  readonly testId: string;
  /** What it says to a screen reader and on hover. The glyph is the same everywhere. */
  readonly label?: string;
  /**
   * Why this one cannot go, from `unlinkRefusal` — the same predicate the channel refuses on.
   *
   * A derived edge is a *reading* of something else, so taking it away here is either undone
   * by the next scan (a `[[wikilink]]`) or permanent in a way nobody asked for (the edge every
   * highlight has to the file it was marked in). The control is drawn either way, because a
   * row that silently has no × leaves the researcher wondering which rows are deletable; it is
   * dead, and it says why in the one place a dead control can — `U07`'s rule, that the reason
   * stands beside the control rather than only in its absence.
   */
  readonly refusal?: string | null;
}): JSX.Element {
  const { run, store } = useWorkspace();
  const stopped = refusal !== null;
  return (
    <button
      type="button"
      className="wr-unlink"
      data-testid={testId}
      data-link-id={linkId}
      data-refusal={stopped ? 'true' : 'false'}
      aria-label={refusal ?? label}
      title={refusal ?? label}
      aria-disabled={stopped ? true : undefined}
      onClick={(event) => {
        // The row underneath is a navigation control on both list surfaces; deleting the link
        // must not also open the thing at its far end.
        event.stopPropagation();
        // Said rather than swallowed: a press on a dead control with no answer reads as a
        // broken button. `disabled` would eat the press *and* the sentence.
        if (stopped) {
          store.setStatus(refusal, 'error');
          return;
        }
        void run(COMMAND_IDS.deleteLink, { linkId });
      }}
    >
      ×
    </button>
  );
}
