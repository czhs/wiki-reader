/**
 * Electron main-process entry point.
 *
 * Owns the filesystem, SQLite, Zotero communication, ingestion, extraction, indexing, and
 * settings. The renderer owns presentation only, and reaches this process through exactly
 * one validated IPC router (criterion M01).
 */
import { app, BrowserWindow, session } from 'electron';
import { join } from 'node:path';
import { createLogger } from './logger.js';
import { createServices, type AppServices } from './services.js';
import { registerRouter, type Router } from './router.js';
import { lockDownNavigation, registerFileProtocol, registerProtocolScheme } from './protocol.js';

const isDev = !app.isPackaged;
const logger = createLogger({ level: isDev ? 'debug' : 'info' });

/** Must be called before the app is ready, or the scheme is not privileged. */
registerProtocolScheme();

let services: AppServices | null = null;
let router: Router | null = null;

/**
 * better-sqlite3 is a native module compiled per ABI. The Electron build is staged
 * separately from the Node build that vitest loads, so the two never overwrite each other.
 */
function nativeBindingPath(): string | undefined {
  const override = process.env['WR_SQLITE_BINDING'];
  if (override !== undefined && override.length > 0) return override;
  const staged = join(
    app.getAppPath(),
    'resources',
    'native',
    `electron-${process.versions.electron ?? 'unknown'}`,
    'better_sqlite3.node',
  );
  return staged;
}

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

  // A renderer that somehow navigates away would be running unknown code with the preload
  // bridge attached, so navigation is refused rather than sandboxed.
  window.webContents.on('will-navigate', (event, url) => {
    const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
    if (rendererUrl === undefined || !url.startsWith(rendererUrl)) {
      event.preventDefault();
      logger.warn('blocked navigation', { url });
    }
  });

  if (isDev && process.env['ELECTRON_RENDERER_URL'] !== undefined) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }

  return window;
}

void app.whenReady().then(() => {
  const databasePath =
    process.env['WR_DATABASE_PATH'] ?? join(app.getPath('userData'), 'wiki-reader.db');

  services = createServices({
    databasePath,
    nativeBinding: nativeBindingPath(),
    logger,
    ...(process.env['WR_ZOTERO_DATA_DIR'] === undefined
      ? {}
      : { zoteroDataDir: process.env['WR_ZOTERO_DATA_DIR'] }),
    // Publishing is late-bound: the router owns the window list, and it does not exist yet.
    publish: (topic, payload) => router?.publish(topic, payload),
  });

  router = registerRouter(services, () =>
    BrowserWindow.getAllWindows().map((window) => window.webContents),
  );

  registerFileProtocol(services, session.defaultSession);
  lockDownNavigation(session.defaultSession);

  logger.info('app ready', { databasePath, electron: process.versions.electron });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  router?.dispose();
  services?.close();
  services = null;
  router = null;
});
