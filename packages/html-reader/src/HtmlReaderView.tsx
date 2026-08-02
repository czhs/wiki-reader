/**
 * The archived-page reader.
 *
 * A saved page is shown *as the page*, not as a summary of it. The markup, the stylesheets
 * and the images that came down with it are what the user saved, and they are what renders —
 * extracted text exists for search and anchoring and is never substituted in when something
 * goes wrong. If the snapshot cannot be read, this says so.
 *
 * The snapshot is loaded by pointing an iframe at the entry document's own `rrfile://` URL,
 * rather than by injecting its markup into this document. That is the whole design:
 *
 *   - relative URLs work by themselves. `<img src="assets/img/figure-1.png">` resolves
 *     against the frame's own URL and comes back through the same protocol handler, which
 *     bounds it to the snapshot it belongs to. Nothing has to rewrite the markup, and
 *     nothing has to guess which of a page's thousand URLs were meant to be local.
 *   - the archived markup never enters the application's document, so it cannot reach the
 *     preload bridge, the workspace, or any other document's bytes.
 *
 * Archived HTML is hostile input — it is markup from the open web, saved verbatim, and it
 * chooses its own URLs. Four things hold it, none of them alone sufficient:
 *
 *   1. `sandbox` with no tokens: scripts do not run, forms cannot submit, the frame cannot
 *      navigate the application away from itself, and its origin is opaque;
 *   2. a restrictive `Content-Security-Policy`, served with the bytes by the protocol handler
 *      (`snapshotSecurityHeaders`), so the policy arrives even if the markup carries its own;
 *   3. every remote request the page makes is cancelled in the main process, so a tracking
 *      pixel cannot report what the user is reading;
 *   4. the protocol handler refuses any resource outside the snapshot's own directory.
 *
 * The highlights made on the page are painted *on* it (`H10`), and that changes none of the
 * four. Nothing is injected from here — there is nowhere to inject it from — and the marks
 * never travel through this component: the process that serves the archive puts them into the
 * bytes it hands the frame, so what arrives is a page with a few `<mark>` elements in it and
 * the same absence of script, origin and permission as before.
 */
import { snapshotMarkElementId } from '@wr/document-model';
import { useEffect, useRef, useState, type JSX } from 'react';

export interface HtmlReaderViewProps {
  readonly documentId: string;
  /** `rrfile://<file-id>` for the snapshot's entry document. */
  readonly fileUrl: string;
  /** Used as the frame's accessible name. */
  readonly title?: string;
  /**
   * An opaque revision of the highlights the page is painted with (`H10`), or `undefined`
   * while the panel does not yet know of any.
   *
   * The marks themselves are not this component's business and never travel through it: the
   * process serving the archive puts them into the bytes, so the frame's very first load
   * already carries whatever the database held. What this is for is the *second* load — an
   * iframe re-fetches when its `src` attribute changes and by nothing else, and a highlight
   * made a moment ago has to appear without the researcher reopening the page.
   */
  readonly marks?: string | undefined;
  /**
   * The annotation the frame should be scrolled to, if it is painted on the page.
   *
   * A fragment, because that is the only way to move a sandboxed archive to a sentence: there
   * is no script inside it to ask and its document is not reachable from out here.
   */
  readonly focusedMarkId?: string | null;
  /**
   * How much bigger than the fit the reader wants the page (`V04`). `null` is the fit itself.
   *
   * Held by the panel, not by this component, so it is the reader's own and survives a
   * restart the way a PDF's zoom does — `ArticleReaderPanelSchema.zoom`.
   */
  readonly zoom?: number | null;
  /** Called with the multiplier the lever moved to. Omit for a view with no lever. */
  readonly onZoom?: (zoom: number) => void;
  /** Called once the snapshot's entry document has been fetched and framed. */
  readonly onReady?: () => void;
  readonly onError?: (message: string) => void;
}

/**
 * The width a saved page is laid out at, whatever the panel happens to be.
 *
 * A page saved from a desktop browser carries its desktop layout, and it chooses which layout
 * to show from its *own* media queries against the viewport it is given. A reading panel with
 * both sidebars open is around 820px, which is below the breakpoint most sites use, so the
 * archived page correctly rendered its narrow layout and dropped its navigation and table of
 * contents — 247 elements of table of contents, present in the markup and `display: none`,
 * on the page this was found with. Nothing was missing; it was being asked to be a phone.
 *
 * So the frame is laid out at desktop width and scaled down to fit when the panel is
 * narrower. Scaling rather than a horizontal scrollbar because sideways scrolling through an
 * article is worse than slightly smaller text, and the *fit* is capped at 1 so a panel with
 * room shows the page pixel-exact rather than blown up. Past that cap is the reader's own
 * decision, and it is the lever below.
 */
const DESKTOP_WIDTH_PX = 1280;

/**
 * The zoom lever (`V04`), and why it is a multiplier on the fit rather than a width.
 *
 * The fixed layout width above is not in question — a page asked to be a phone drops its
 * navigation, and that is a worse reading than small text. What the researcher was missing is
 * a say in the *shrink*: at half a screen the fit is 0.63, and beside a focused view it is
 * 0.31, which is body text at five pixels and nothing to be done about it.
 *
 * So the lever scales the frame independently of the fit and leaves the layout width alone.
 * The page keeps the desktop layout it was saved with at every step; past 1× it is simply
 * larger than the panel and the panel scrolls, which is the trade the researcher asked for
 * when they pulled the lever and never one they are given by surprise. Coarse steps, because
 * a slider over a value with no numeric meaning is a control nobody can return to.
 */
const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3] as const;
const FIT = 1;
const SMALLEST = ZOOM_STEPS[0];
const LARGEST = ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? FIT;

/** The nearest step in `direction`, or the one we are on when there is no room left. */
function stepZoom(from: number, direction: 1 | -1): number {
  const ordered = direction === 1 ? [...ZOOM_STEPS] : [...ZOOM_STEPS].reverse();
  return ordered.find((step) => (direction === 1 ? step > from : step < from)) ?? from;
}

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly status: 'error'; readonly message: string };

/** Ids that may be written into a URL fragment as they stand. Minted ids are all of them. */
const SAFE_FRAGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Confirm the snapshot is really there, and really a page, before framing it.
 *
 * Without this the failure modes are silent: a missing file or a refused path renders
 * Chromium's own error page *inside* the frame, which looks like a page that saved badly
 * rather than like an application that could not open it. The frame is pointed at the same
 * URL afterwards and fetches it again — an entry page is served `no-store` because it is a
 * view of the database as much as of the file.
 */
async function probeSnapshot(fileUrl: string): Promise<void> {
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`${String(response.status)} ${response.statusText}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^text\/html\b/i.test(contentType)) {
    // Falling back to some other rendering here is exactly the silent substitution the
    // reader must not make: this document's primary file is not a page.
    throw new Error(`the saved file is ${contentType === '' ? 'of unknown type' : contentType}`);
  }
  // The body is drained rather than left dangling so the response does not stay open.
  await response.text();
}

export function HtmlReaderView({
  documentId,
  fileUrl,
  title,
  marks,
  focusedMarkId,
  zoom,
  onZoom,
  onReady,
  onError,
}: HtmlReaderViewProps): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  /**
   * The revision that was already on the page when this frame first loaded it.
   *
   * The marks are painted by the process that serves the archive, so the first revision this
   * view is *told* about is the one it is already showing — reloading for it would send a long
   * article back to the top a moment after opening it, for no change at all. Only a revision
   * that differs from this one is a reason to fetch again.
   */
  const shownOnLoad = useRef<{ readonly url: string; readonly marks: string } | null>(null);
  if (marks !== undefined && shownOnLoad.current?.url !== fileUrl) {
    shownOnLoad.current = { url: fileUrl, marks };
  }
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });

  // Track the panel, because the width the page is *laid out* at decides which layout it
  // chooses, and that is not the same question as how much room we have to show it.
  useEffect(() => {
    const element = viewportRef.current;
    if (element === null) return undefined;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box === undefined) return;
      setViewport({ width: box.width, height: box.height });
    });
    observer.observe(element);
    setViewport({ width: element.clientWidth, height: element.clientHeight });
    return () => {
      observer.disconnect();
    };
  }, [state.status]);

  const frameWidth = Math.max(viewport.width, DESKTOP_WIDTH_PX);

  // Held in refs so the effect below keys on the *URL* and nothing else. Depending on the
  // callbacks meant a caller passing an inline arrow — which is the ordinary way to write
  // `onError={(m) => store.setStatus(m, 'error')}`, and what the article panel does — re-ran
  // this effect on every render of its parent. That path sets the status back to 'loading',
  // which unmounts the iframe, and remounting a frame pointed at a URL is a full page load:
  // the scroll position is lost and every image decodes again. Any unrelated workspace
  // change sent a long article back to the top. `[UX07]` is the regression test.
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  const errorRef = useRef(onError);
  errorRef.current = onError;

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void (async () => {
      try {
        await probeSnapshot(fileUrl);
        if (cancelled) return;
        setState({ status: 'ready' });
        readyRef.current?.();
      } catch (error) {
        const message = `Could not open this saved page: ${
          error instanceof Error ? error.message : String(error)
        }`;
        if (cancelled) return;
        setState({ status: 'error', message });
        errorRef.current?.(message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileUrl]);

  if (state.status === 'loading') {
    return (
      <div className="wr-html-reader wr-html-reader--status" data-testid="html-reader-loading">
        Opening saved page…
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="wr-html-reader wr-html-reader--status" data-testid="html-reader-error">
        {state.message}
      </div>
    );
  }

  // The frame is laid out at `frameWidth` and scaled to fill the panel, so its own height
  // has to be the panel's divided by that scale for the scaled result to reach the bottom.
  const fit = frameWidth === 0 ? 1 : Math.min(1, viewport.width / frameWidth);
  // What the reader is actually looking at: the fit, times whatever the lever is set to. One
  // number, published as one attribute — the scaled frame is where Playwright's own
  // hit-testing is wrong, and every caller that computes a point inside the page computes it
  // from this. A lever that moved the picture without moving the attribute would put every
  // click on the page's `<body>`.
  const scale = fit * (zoom ?? FIT);
  const frameHeight = scale === 0 ? viewport.height : viewport.height / scale;

  // The query is a cache-buster and nothing else: what is painted is decided where the bytes
  // are, from the database, and never from anything the page could ask for.
  const revision = marks !== undefined && marks !== shownOnLoad.current?.marks ? marks : null;
  const query = revision === null ? '' : `?marks=${encodeURIComponent(revision)}`;
  const fragment =
    typeof focusedMarkId === 'string' && SAFE_FRAGMENT.test(focusedMarkId)
      ? `#${snapshotMarkElementId(focusedMarkId)}`
      : '';
  const frameUrl = `${fileUrl}${query}${fragment}`;

  return (
    <div
      className="wr-html-reader"
      data-testid="html-reader"
      data-document-id={documentId}
      data-snapshot-scale={scale.toFixed(3)}
      data-snapshot-fit={fit.toFixed(3)}
      data-snapshot-zoom={String(zoom ?? FIT)}
    >
      {onZoom !== undefined && (
        /* Beside the page rather than over it: the archive is framed, and a control drawn on
           top of it would sit on the words at the one width where the words are shortest. */
        <div
          className="wr-html-reader__lever"
          data-testid="snapshot-zoom"
          data-control="snapshot.zoom"
        >
          <button
            type="button"
            className="wr-button wr-button--quiet"
            data-testid="snapshot-zoom-out"
            title="Smaller"
            aria-label="Show the page smaller"
            disabled={(zoom ?? FIT) <= SMALLEST}
            onClick={() => {
              onZoom(stepZoom(zoom ?? FIT, -1));
            }}
          >
            −
          </button>
          {/* The effective scale, not the multiplier: what the reader wants to know is how
              big the page is on screen, and in a half-width panel 1× is 63%. */}
          <button
            type="button"
            className="wr-button wr-button--quiet"
            data-testid="snapshot-zoom-reset"
            title="Fit the page to the panel"
            aria-label="Fit the page to the panel"
            disabled={(zoom ?? FIT) === FIT}
            onClick={() => {
              onZoom(FIT);
            }}
          >
            {`${String(Math.round(scale * 100))}%`}
          </button>
          <button
            type="button"
            className="wr-button wr-button--quiet"
            data-testid="snapshot-zoom-in"
            title="Bigger"
            aria-label="Show the page bigger"
            disabled={(zoom ?? FIT) >= LARGEST}
            onClick={() => {
              onZoom(stepZoom(zoom ?? FIT, 1));
            }}
          >
            +
          </button>
        </div>
      )}
      {/* The measured element, and the one that scrolls. The lever is its sibling rather than
          its child: what the frame is laid out and scaled against is the room left for the
          *page*, and a control measured as part of that room would move the fit every time it
          appeared. */}
      <div ref={viewportRef} className="wr-html-reader__viewport" data-testid="snapshot-viewport">
        <iframe
          ref={frameRef}
          className="wr-html-reader__frame"
          data-testid="snapshot-frame"
          title={title ?? 'Saved page'}
          src={frameUrl}
          // Empty, and deliberately so: every sandbox token is a capability granted back.
          // `allow-scripts` would run the page's JavaScript; `allow-same-origin` would give it
          // a real origin and with it access to the rest of this scheme.
          sandbox=""
          referrerPolicy="no-referrer"
          style={{
            width: `${String(frameWidth)}px`,
            height: `${String(frameHeight)}px`,
            transform: scale === 1 ? undefined : `scale(${String(scale)})`,
            transformOrigin: '0 0',
          }}
        />
      </div>
    </div>
  );
}
