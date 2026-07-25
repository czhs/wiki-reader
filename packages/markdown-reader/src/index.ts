/**
 * @wr/markdown-reader — markdown presentation, selection capture and highlight painting.
 *
 * The corpus is markdown, and this is where it is read. Rendering goes from the mdast to
 * React elements without ever building an HTML string, so a corpus file cannot inject markup
 * into the app's origin.
 */
export { MarkdownReaderView, type MarkdownReaderViewProps } from './MarkdownReaderView.js';
export {
  renderMarkdown,
  renderMarkdownToElement,
  type RenderedHighlight,
  type RenderOptions,
  type WikilinkRenderer,
} from './render.js';
export { createMarkdownAnchorFromSelection } from './anchoring.js';
