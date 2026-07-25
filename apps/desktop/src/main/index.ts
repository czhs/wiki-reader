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
import {
  APP_ORIGIN,
  lockDownNavigation,
  registerAppProtocol,
  registerFileProtocol,
  registerProtocolScheme,
} from './protocol.js';

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

/**
 * Background mode: run without taking over the machine.
 *
 * Automated runs — the E2E suite, CI, anything driven by the Ralph loop — launch the real
 * app on a developer's active desktop. Left alone, macOS activates the app, raises its
 * window over whatever is in front, and bounces a dock icon, which makes an unattended test
 * run steal the keyboard mid-sentence. This is a runtime mode, not a test-only branch: the
 * window still renders and still drives, it simply never asks to be frontmost.
 *
 * Playwright drives the renderer over CDP, which injects input directly and does not depend
 * on OS focus, so nothing about the suite's fidelity is weakened by staying in the back.
 */
const isBackground = process.env['WR_BACKGROUND'] === '1';

/**
 * True when `url` is a navigation the renderer is allowed to perform.
 *
 * Origin comparison, never a string prefix. `url.startsWith(rendererUrl)` with
 * `ELECTRON_RENDERER_URL=http://localhost:5173` admits `http://localhost:5173.evil.com/`,
 * which is a different host that merely begins with the same characters — the same collision
 * `isInsideRoot` exists to prevent for paths.
 *
 * `app://bundle/` is the packaged renderer's own origin; the trailing slash is what stops
 * `app://bundleevil/` from passing, and it is compared as an origin plus path prefix because
 * `app://` URLs are opaque to `URL.origin` in some Electron versions.
 */
function isAllowedNavigation(url: string): boolean {
  if (url.startsWith(`${APP_ORIGIN}/`)) return true;

  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  if (rendererUrl === undefined) return false;
  try {
    return new URL(url).origin === new URL(rendererUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Bind the navigation and window-opening locks to *every* `webContents`, not just the one
 * `createWindow` builds.
 *
 * Attaching these inside `createWindow` left them conditional on the code path that made the
 * contents. Nothing else can create one today — `webviewTag: false`, no `BrowserView`, no
 * `WebContentsView`, no devtools — but an invariant that holds because of an inventory of
 * call sites stops holding the moment someone adds one.
 */
app.on('web-contents-created', (_event, contents) => {
  // Refuse every attempt to open a new window; internal links are handled by commands.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // A renderer that somehow navigates away would be running unknown code with the preload
  // bridge attached, so navigation is refused rather than sandboxed.
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
      logger.warn('blocked navigation', { url });
    }
  });
});

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
      // A never-shown window is throttled by the compositor, which stalls timers and rAF —
      // that turns PDF.js rendering into flaky E2E timeouts. Only disabled in background
      // mode; a real user's minimized window should still throttle to save battery.
      backgroundThrottling: !isBackground,
    },
  });

  // In background mode the window is never presented at all — not even inactively. A window
  // that merely avoids taking focus still appears on the desktop, and an unattended suite
  // launching one per spec litters the screen. The renderer runs and paints regardless, and
  // Playwright drives it over CDP, so nothing needs to be on screen for the suite to work.
  window.once('ready-to-show', () => {
    if (!isBackground) window.show();
  });

  if (isDev && process.env['ELECTRON_RENDERER_URL'] !== undefined) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    // Served over `app://`, never `file://` — see `registerAppProtocol` for why.
    void window.loadURL(`${APP_ORIGIN}/index.html`);
  }

  return window;
}

// Set before `whenReady` so the app never appears in the dock or the app switcher at all —
// `accessory` also stops macOS from activating it when its first window appears.
if (isBackground && process.platform === 'darwin') {
  app.setActivationPolicy('accessory');
  app.dock?.hide();
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
  registerAppProtocol(session.defaultSession, join(import.meta.dirname, '../renderer'), logger);
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
