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
 */
import { useEffect, useRef, useState, type JSX } from 'react';

export interface HtmlReaderViewProps {
  readonly documentId: string;
  /** `rrfile://<file-id>` for the snapshot's entry document. */
  readonly fileUrl: string;
  /** Used as the frame's accessible name. */
  readonly title?: string;
  /** Called once the snapshot's entry document has been fetched and framed. */
  readonly onReady?: () => void;
  readonly onError?: (message: string) => void;
}

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly status: 'error'; readonly message: string };

/**
 * Confirm the snapshot is really there, and really a page, before framing it.
 *
 * Without this the failure modes are silent: a missing file or a refused path renders
 * Chromium's own error page *inside* the frame, which looks like a page that saved badly
 * rather than like an application that could not open it. The frame is pointed at the same
 * URL afterwards and is served from the HTTP cache.
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
  onReady,
  onError,
}: HtmlReaderViewProps): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const frameRef = useRef<HTMLIFrameElement | null>(null);

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

  return (
    <div className="wr-html-reader" data-testid="html-reader" data-document-id={documentId}>
      <iframe
        ref={frameRef}
        className="wr-html-reader__frame"
        data-testid="snapshot-frame"
        title={title ?? 'Saved page'}
        src={fileUrl}
        // Empty, and deliberately so: every sandbox token is a capability granted back.
        // `allow-scripts` would run the page's JavaScript; `allow-same-origin` would give it
        // a real origin and with it access to the rest of this scheme.
        sandbox=""
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
