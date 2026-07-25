/**
 * `@wr/html-reader` — reading a saved web page.
 *
 * The reader shows the archived page itself, framed from its own `rrfile://` origin so the
 * stylesheets and images saved with it load the way they did on the site. `HtmlReaderView`
 * says why it is an iframe and what confines it.
 *
 * Reader mode — Readability's extracted article offered as an alternative *rendering* — is
 * not built. The extracted text this app keeps is for search and anchoring; presenting it as
 * the reading view is a separate decision, and `HtmlLocation.readerMode` records which
 * rendering an offset belongs to precisely so the two can never be confused.
 */
export { HtmlReaderView, type HtmlReaderViewProps } from './HtmlReaderView.js';
export { createHtmlAnchorFromSelection } from './anchoring.js';

export const PACKAGE_NAME = '@wr/html-reader' as const;
