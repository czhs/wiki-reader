/**
 * Renderer entry point.
 *
 * Owns React, the Dockview workspace, PDF and HTML presentation, selection, annotation
 * rendering, notes, and search UI — and nothing else. It reaches the main process only
 * through `window.rr`, the two-function preload bridge.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'dockview/dist/styles/dockview.css';
import '@wr/shared-ui/styles.css';
import '@wr/pdf-reader/styles.css';
import '@wr/markdown-reader/styles.css';
import '@wr/html-reader/styles.css';
import '@wr/annotations/styles.css';
import '@wr/note-editor/styles.css';
import './shell.css';
import './guide.css';
import { App } from './App.js';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('renderer: #root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
