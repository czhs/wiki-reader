/**
 * The two things a Typst notebook has that a markdown one did not (criteria S05, S07).
 *
 * **Headers.** A global one that every notebook gets and a local one this notebook adds, in
 * that order, so a notebook can shadow a global definition without editing anything anybody
 * else's page reads. Both are stored — the global in `settings`, the local on the notebook's
 * row — because a header the researcher cannot edit in the app is a header they cannot edit at
 * all: the renderer never receives a filesystem path, so a file on disk would be out of reach.
 * Neither is stored when it does not compile, and the reason is shown where it was typed.
 *
 * **The live render.** The typeset page, beside or beneath the writing depending on the shape
 * of the panel (`liveRenderPlacement`). SVG, from the paged target: its glyphs are `<path>`
 * elements and it has no text in it at all, which is exactly why it can never quietly become
 * the surface the researcher edits. Compiled in the main process, debounced, so a slow compile
 * is a stale picture rather than a held keystroke.
 */
import { useEffect, useState } from 'react';
import type { TypstStackedPlacement } from '@wr/shared-types';
import { call, describeError } from './ipc.js';
import { typstHeadersChanged, useTypstRender } from './typst-view.js';
import type { LiveRenderPlacement } from './live-render.js';

/** Long enough that a sentence being typed is one compile, short enough to feel live. */
const RENDER_DEBOUNCE_MS = 250;

export function TypstHeaders({
  questionId,
  localHeader,
  onLocalSaved,
  stackedPlacement,
  onStackedPlacement,
}: {
  readonly questionId: string;
  readonly localHeader: string;
  readonly onLocalSaved: () => void;
  /**
   * Where the render goes when the panel is tall. Owned by the page rather than by this
   * control: the page is what draws the render, and a control holding its own copy of the
   * answer is a control that can disagree with what is on screen.
   */
  readonly stackedPlacement: TypstStackedPlacement;
  readonly onStackedPlacement: (placement: TypstStackedPlacement) => void;
}): JSX.Element {
  const [global, setGlobal] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    void call('typst:getSettings', {})
      .then((answer) => {
        setGlobal(answer.settings.globalHeader);
      })
      .catch((failure: unknown) => {
        setGlobalError(describeError(failure).message);
      });
  }, []);

  const saveGlobal = (text: string): void => {
    void call('typst:setSettings', { globalHeader: text })
      .then((answer) => {
        setGlobalError(answer.error);
        setGlobal(answer.settings.globalHeader);
        // Every notebook on screen is compiled against this; a page still drawing the old
        // definitions after they were replaced is the one failure a cache can cause here.
        if (answer.error === null) typstHeadersChanged();
      })
      .catch((failure: unknown) => {
        setGlobalError(describeError(failure).message);
      });
  };

  const saveLocal = (text: string): void => {
    void call('notebook:writeHeader', { questionId, header: text })
      .then((answer) => {
        setLocalError(answer.error);
        if (answer.error === null) {
          typstHeadersChanged();
          onLocalSaved();
        }
      })
      .catch((failure: unknown) => {
        setLocalError(describeError(failure).message);
      });
  };

  return (
    <div className="wr-notebook__headers">
      <label className="wr-notebook__field">
        <span>Every notebook</span>
        <textarea
          className="wr-input wr-notebook__header"
          data-testid="typst-global-header"
          data-control="notebook.globalHeader"
          aria-label="Typst header for every notebook"
          placeholder="#let claim(body) = strong(body)"
          defaultValue={global ?? ''}
          key={`global-${String(global !== null)}`}
          onBlur={(event) => saveGlobal(event.target.value)}
        />
      </label>
      {globalError !== null && (
        <p className="wr-notebook__header-error" data-testid="typst-global-header-error">
          {globalError}
        </p>
      )}
      <label className="wr-notebook__field">
        <span>This notebook</span>
        <textarea
          className="wr-input wr-notebook__header"
          data-testid="typst-local-header"
          data-control="notebook.localHeader"
          aria-label="Typst header for this notebook"
          placeholder="#let claim(body) = emph(body)"
          defaultValue={localHeader}
          key={`local-${questionId}`}
          onBlur={(event) => saveLocal(event.target.value)}
        />
      </label>
      {localError !== null && (
        <p className="wr-notebook__header-error" data-testid="typst-local-header-error">
          {localError}
        </p>
      )}
      <label className="wr-notebook__field">
        <span>Live render, when the page is tall</span>
        <select
          className="wr-input"
          data-testid="typst-render-placement"
          data-control="notebook.renderPlacement"
          value={stackedPlacement}
          onChange={(event) => onStackedPlacement(event.target.value as TypstStackedPlacement)}
        >
          <option value="below">Beneath the writing</option>
          <option value="top">Above the writing</option>
          <option value="off">Off</option>
        </select>
      </label>
    </div>
  );
}

/**
 * The typeset page, live.
 *
 * The whole document is compiled — headers, every block — because that is what the page will
 * look like, and a preview of one block is not a preview of a paper. Debounced rather than
 * throttled: what the researcher wants to see is the sentence they have just finished, not
 * every intermediate state of it.
 */
export function LiveRender({
  questionId,
  body,
  placement,
  widthPt,
}: {
  readonly questionId: string;
  readonly body: string;
  readonly placement: Exclude<LiveRenderPlacement, 'none'>;
  readonly widthPt: number;
}): JSX.Element {
  const rendering = useTypstRender(body, {
    questionId,
    target: 'svg',
    widthPt,
    debounceMs: RENDER_DEBOUNCE_MS,
  });
  return (
    <aside
      className={`wr-notebook__render wr-notebook__render--${placement}`}
      data-testid="notebook-live-render"
      data-placement={placement}
      aria-label="The typeset page"
    >
      {rendering.error !== null && (
        <p className="wr-notebook__render-error" data-testid="notebook-live-render-error">
          {rendering.error}
        </p>
      )}
      {rendering.svg !== null && (
        // The compiler's own SVG, as an image rather than as inline markup: a `data:` URI is
        // what the window's `img-src` already allows, and it means nothing here ever hands a
        // string to a parser that could treat it as markup in this origin.
        <img
          className="wr-notebook__render-page"
          data-testid="notebook-live-render-page"
          alt="The page, typeset"
          src={`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(rendering.svg)))}`}
        />
      )}
    </aside>
  );
}
