/**
 * Starting a notebook.
 *
 * Two surfaces offer it — the shelf (`P01`) and the queue in the sidebar — and the guide treats
 * them as one feature, because they are: both carry `data-control="notebook.new"`, and a
 * researcher who has learned one has learned the other. They were two copies of the same input
 * and button, down to the placeholder and the Enter handler, which is how the two would have
 * ended up wording the same gesture differently.
 *
 * What is *not* shared is what happens after: the shelf opens the notebook it just named,
 * because a notebook you have just named is one you are about to write in, and the queue stays
 * where it is. So the control owns the draft and nothing else, and hands the title over.
 */
import { useCallback, useState } from 'react';

export function NewNotebookControl({
  testIdPrefix,
  className,
  onAdd,
}: {
  /** Names both test ids: `<prefix>-new-title` and `<prefix>-add`. */
  readonly testIdPrefix: string;
  readonly className: string;
  /**
   * Create it. Resolving means it was created — the draft is cleared then and not before, so a
   * title that failed to save is still in the box to try again.
   */
  readonly onAdd: (title: string) => Promise<boolean>;
}): JSX.Element {
  const [draft, setDraft] = useState('');

  const add = useCallback(async () => {
    const title = draft.trim();
    if (title === '') return;
    if (await onAdd(title)) setDraft('');
  }, [draft, onAdd]);

  return (
    <div className={className}>
      <input
        className="wr-input"
        type="text"
        placeholder="What are you working on?"
        aria-label="New notebook"
        data-testid={`${testIdPrefix}-new-title`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void add();
        }}
      />
      <button
        type="button"
        className="wr-button"
        data-testid={`${testIdPrefix}-add`}
        data-control="notebook.new"
        disabled={draft.trim() === ''}
        onClick={() => void add()}
      >
        New notebook
      </button>
    </div>
  );
}
