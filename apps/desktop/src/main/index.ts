/**
 * Electron main-process entry point.
 *
 * Owns the filesystem, SQLite, Zotero communication, ingestion, extraction, indexing, and
 * settings. The renderer owns presentation only, and reaches this process through exactly
 * one validated IPC router (criterion M01).
 */
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

const isDev = !app.isPackaged;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'wiki-reader',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      // Security invariants. scripts/verify_completion.py asserts all three.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  // Refuse every attempt to open a new window; internal links are handled by commands.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (isDev && process.env['ELECTRON_RENDERER_URL'] !== undefined) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }

  return window;
}

void app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
