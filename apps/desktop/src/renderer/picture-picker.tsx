/**
 * Choosing a picture the library already holds (criteria S06, S08).
 *
 * `+ image` had no button for years and the comment said why: the bytes have to come from the
 * operating system, and nothing in the renderer's world can ask for them. That is still true of
 * a *new* picture — it arrives by being dropped — but it was never true of one that has already
 * been dropped once. A picture in the library is a row, and putting the same figure in a second
 * section should not mean finding it on disk again.
 *
 * So this offers what `document_files` already holds, by the same query the graph's icon picker
 * uses. It answers with a **file id**, never a path: the id is what `rrfile://` resolves for the
 * window and what the Typst compiler is handed bytes under, and neither of those two ever tells
 * this side where the file is.
 */
import { useEffect, useState } from 'react';
import { call } from './ipc.js';
import { Overlay, useCloseOnEscape } from './overlays.js';

/** Enough to choose from; a gallery of every image in a library is a list nobody scans. */
const LIMIT = 60;

export function PicturePicker({
  onChoose,
  onDismiss,
}: {
  readonly onChoose: (picture: { readonly fileId: string; readonly title: string }) => void;
  readonly onDismiss: () => void;
}): JSX.Element {
  const [choices, setChoices] = useState<readonly { fileId: string; title: string }[] | null>(null);
  useCloseOnEscape(true, onDismiss);

  useEffect(() => {
    let live = true;
    void call('graph:iconChoices', { limit: LIMIT })
      .then((answer) => {
        if (live) setChoices(answer.choices);
      })
      .catch(() => {
        // A picker that could not be filled is an empty picker, not a broken page.
        if (live) setChoices([]);
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <Overlay name="picture-picker" onDismiss={onDismiss}>
      <div className="wr-picker" data-testid="picture-picker" role="dialog" aria-label="Add a picture">
        <h3 className="wr-picker__title">Add a picture</h3>
        {choices === null && <p className="wr-picker__empty">Looking…</p>}
        {choices !== null && choices.length === 0 && (
          <p className="wr-picker__empty" data-testid="picture-picker-empty">
            Nothing in the library yet — drop a picture on the page to add one.
          </p>
        )}
        <div className="wr-picker__options">
          {(choices ?? []).map((choice) => (
            <button
              key={choice.fileId}
              type="button"
              className="wr-picker__option"
              data-testid={`picture-picker-${choice.fileId}`}
              onClick={() => onChoose(choice)}
            >
              <img className="wr-picker__thumb" src={`rrfile://${choice.fileId}`} alt="" />
              {choice.title}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="wr-button wr-button--quiet"
          data-testid="picture-picker-dismiss"
          onClick={onDismiss}
        >
          Cancel
        </button>
      </div>
    </Overlay>
  );
}
