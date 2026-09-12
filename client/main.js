'use strict';

const {
  app, BrowserWindow, ipcMain, shell, Notification, Menu, nativeTheme, protocol, net: electronNet, screen,
  Tray, nativeImage, session, desktopCapturer, clipboard, safeStorage} = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const updater = require('./updater');
const { rgbaToPng, markIconPng } = require('./icon-art');

// --- the server this build talks to -----------------------------------------
// Voxara is a single-community app: everyone signs in to the same server, so the
// address is part of the build rather than something each person has to know.
// PULSE_SERVER_URL overrides it for local development.
const HOME_SERVER_URL = process.env.PULSE_SERVER_URL || 'wss://voxaraspace.com';

const IS_DEV = !app.isPackaged;
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

const RENDERER_DIR = path.join(__dirname, 'src');
const APP_ORIGIN = 'app://pulse';

// Chromium refuses to load ES modules over file:// (opaque origin, CORS), so the
// renderer is served from a registered standard scheme instead.
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const { pathname } = new URL(request.url);
    const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const resolved = path.normalize(path.join(RENDERER_DIR, relative));

    // Never serve anything outside the renderer directory.
    if (resolved !== RENDERER_DIR && !resolved.startsWith(RENDERER_DIR + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    const response = await electronNet.fetch(pathToFileURL(resolved).toString());
    // Without an explicit directive Chromium caches these heuristically, which
    // leaves a reloaded window running the previous version's JS and CSS.
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'no-cache');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
}

let mainWindow = null;

// --- certificate pinning ---------------------------------------------------

/**
 * The production server presents a certificate from a public CA, so a
 * certificate error there is never legitimate: it is refused outright, with
 * a plain explanation, and nothing is remembered about it. (An earlier
 * version trusted whatever certificate it saw first, which on a fresh install
 * would have accepted an interceptor's certificate as the real one.)
 *
 * The one exception is a server on this same machine (localhost), which is
 * what a development or test build talks to; those issue their own
 * certificate, so trust-on-first-use applies there and only there.
 */
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/i;
const warnedHosts = new Set();
function handleCertificate(event, url, certificate, callback) {
  let host;
  let hostname;
  try {
    ({ host, hostname } = new URL(url));
  } catch {
    return callback(false);
  }
  if (!LOOPBACK_HOST.test(hostname)) {
    console.error(`[pulse] certificate for ${host} failed validation — refusing to connect`);
    if (!warnedHosts.has(host)) {
      warnedHosts.add(host);
      dialog.showErrorBox(
        'This connection is not secure',
        `The certificate presented by ${host} is not valid, so Voxara will not `
        + 'connect.\n\nThis can happen on a network that intercepts traffic '
        + '(some hotel, school or office networks) or if your computer\'s clock '
        + 'is wrong. Try another network, or check the date and time.',
      );
    }
    return callback(false);
  }

  const settings = readSettings();
  const pins = settings.pinnedCerts || {};
  const seen = pins[host];
  const offered = certificate.fingerprint;

  if (!seen) {
    pins[host] = offered;
    writeSettings({ ...settings, pinnedCerts: pins });
    console.log(`[pulse] pinned certificate for ${host}: ${offered}`);
    event.preventDefault();
    return callback(true);
  }

  if (seen === offered) {
    event.preventDefault();
    return callback(true);
  }

  console.error(`[pulse] certificate for ${host} changed — refusing to connect`);
  dialog.showErrorBox(
    'The server\'s identity changed',
    `The certificate presented by ${host} does not match the one this computer `
    + 'trusted before.\n\nThis happens if the server was reinstalled — or if '
    + 'something is intercepting the connection.\n\nIf you know the server was '
    + 'rebuilt, remove its entry from settings.json under "pinnedCerts" and try again.',
  );
  return callback(false);
}

/** The pinned fingerprint for a host, in Chromium's `sha256/BASE64` form. */
function pinnedFor(host) {
  const pins = readSettings().pinnedCerts || {};
  return pins[host] || null;
}

updater.usePinStore(pinnedFor);

// ---------------------------------------------------------------- settings io

// The session token is the one thing in this file worth encrypting, not just
// permission-restricting — it's a 30-day bearer credential for the account.
// safeStorage hands it to the OS's own secret store (DPAPI on Windows,
// Keychain on macOS, kwallet/libsecret or an obfuscated fallback on Linux),
// so the plaintext token exists only in memory, never on disk. Encrypted
// on the way out, decrypted transparently on the way in — every other
// caller of read/writeSettings just keeps seeing `token` as a plain string.
function decryptSettingsToken(settings) {
  if (typeof settings.tokenEnc !== 'string') return settings;
  const { tokenEnc, ...rest } = settings;
  if (!safeStorage.isEncryptionAvailable()) return rest; // unreadable this run; sign in again rather than crash
  try {
    return { ...rest, token: safeStorage.decryptString(Buffer.from(tokenEnc, 'base64')) };
  } catch {
    // Moved to a different machine/OS keychain, or the local key changed —
    // the ciphertext is unusable either way. Drop it; signing in again is
    // the only recovery, and holding onto garbage ciphertext forever isn't
    // better than that.
    return rest;
  }
}

function encryptSettingsToken(settings) {
  if (typeof settings.token !== 'string' || !settings.token) return settings;
  if (!safeStorage.isEncryptionAvailable()) return settings; // best available is the existing 0600 plaintext
  try {
    const { token, ...rest } = settings;
    return { ...rest, tokenEnc: safeStorage.encryptString(token).toString('base64') };
  } catch {
    return settings; // encryption failed — keep the plaintext token rather than lose the session
  }
}

function readSettings() {
  try {
    return decryptSettingsToken(JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
    // 0600 regardless: defence in depth even though the token itself is now
    // encrypted at rest where the OS supports it.
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(encryptSettingsToken(settings), null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(SETTINGS_FILE(), 0o600);
  } catch (err) {
    console.error('[pulse] could not save settings:', err.message);
  }
}

// Window lifecycle breadcrumbs: packaged apps have no console, and the
// minimize/restore bugs only reproduce on real machines. %APPDATA%\pulse-client\window.log
function winlog(message) {
  try {
    let scale = '?';
    try { scale = screen.getPrimaryDisplay().scaleFactor; } catch { /* pre-ready */ }
    const state = mainWindow && !mainWindow.isDestroyed()
      ? `${JSON.stringify(mainWindow.getBounds())} min=${mainWindow.isMinimized()} filled=${Boolean(mainWindow.__filled)} scale=${scale}`
      : 'no-window';
    fs.appendFileSync(path.join(app.getPath('userData'), 'window.log'),
      `${new Date().toISOString()}  ${message}  ${state}\n`);
  } catch { /* best effort */ }
}

// ------------------------------------------------------------ embedded server


// ------------------------------------------------------------------- window

/**
 * Keeps a remembered window on screen. Saved bounds can outlive the display
 * they were saved on — a monitor unplugged, the resolution changed, or the
 * window dragged mostly off the edge — and the window then opens with its
 * title bar or its composer beyond the screen, where they cannot be reached.
 */
function fitToScreen(saved) {
  const DEFAULT = { width: 1280, height: 820 };
  const target = (saved.x !== undefined && saved.y !== undefined)
    ? screen.getDisplayMatching({
      x: Math.round(saved.x),
      y: Math.round(saved.y),
      width: Math.round(saved.width || DEFAULT.width),
      height: Math.round(saved.height || DEFAULT.height),
    })
    : screen.getPrimaryDisplay();
  const area = target.workArea;

  // A saved size bigger than the screen is stale rather than intentional, so
  // fall back to the default. Clamping it to exactly the work area instead
  // would leave the restored size identical to the maximized one, and the
  // restore button would look broken.
  const tooWide = (saved.width || 0) > area.width;
  const tooTall = (saved.height || 0) > area.height;
  const wanted = {
    width: tooWide ? DEFAULT.width : (saved.width || DEFAULT.width),
    height: tooTall ? DEFAULT.height : (saved.height || DEFAULT.height),
  };
  const width = Math.max(820, Math.min(wanted.width, area.width));
  const height = Math.max(560, Math.min(wanted.height, area.height));

  // The flag must survive this sanitising, or a window closed maximized
  // reopens floating — which made every update look like it shrank the app.
  const maximized = Boolean(saved.maximized);

  // Leaving x/y undefined lets Electron centre the window, which is what we
  // want the first time and whenever the saved position is unusable.
  if (saved.x === undefined || saved.y === undefined) return { width, height, maximized };

  const x = Math.min(Math.max(Math.round(saved.x), area.x), area.x + area.width - width);
  const y = Math.min(Math.max(Math.round(saved.y), area.y), area.y + area.height - height);
  return { width, height, x, y, maximized };
}

/** Nudges an already-created window back inside its display's work area. */
function ensureOnScreen(win) {
  // A window filled to the work area is deliberately at the edges; leaving it
  // to fillWorkArea keeps the two from fighting. Full-screen is the OS's.
  if (!win || win.isDestroyed() || win.__filled || win.isFullScreen()) return;
  // Changing the bounds of a minimized window desyncs the OS restore rect from
  // the renderer viewport — the window then reopens clipped, with the composer
  // beyond its bottom edge. Defer any fixing until it is restored.
  if (win.isMinimized()) { win.__pendingFit = true; return; }
  const got = win.getBounds();
  const area = screen.getDisplayMatching(got).workArea;

  const width = Math.min(got.width, area.width);
  const height = Math.min(got.height, area.height);
  const x = Math.min(Math.max(got.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(got.y, area.y), area.y + area.height - height);

  if (x !== got.x || y !== got.y || width !== got.width || height !== got.height) {
    win.setBounds({ x, y, width, height });
  }
}

// True while we are the ones moving the window, so the 'maximize' handler does
// not mistake our own correction for a fresh native maximize and recurse.
let adjustingBounds = false;

/** The work area (screen minus taskbar) of whichever display the window is on. */
function currentWorkArea() {
  const base = mainWindow ? mainWindow.getBounds() : screen.getPrimaryDisplay().bounds;
  return screen.getDisplayMatching(base).workArea;
}

function reportMaximized() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('window:maximized', Boolean(mainWindow.__filled));
}

/**
 * Fills the display's work area exactly. Native maximize is avoided on purpose:
 * a frameless window maximized on Windows is positioned a few pixels beyond
 * every screen edge (the invisible resize border), which clips our own title
 * bar off the top. Setting the bounds to the work area fills the screen without
 * that overflow, so the title bar stays fully visible.
 */
function applyFill(area) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Same deferral as ensureOnScreen: never reshape a minimized window.
  if (mainWindow.isMinimized()) { mainWindow.__pendingFit = true; return; }
  if (!mainWindow.__filled) mainWindow.__restoreBounds = mainWindow.getBounds();
  // Already filling this display correctly? Do nothing — re-setting bounds on
  // every focus is what caused the flicker (and the monitor jump).
  const b = mainWindow.getBounds();
  const alreadyFilled = !mainWindow.isMaximized()
    && b.x === area.x && b.y === area.y && b.width === area.width && b.height === area.height;
  if (alreadyFilled) { mainWindow.__filled = true; reportMaximized(); return; }
  adjustingBounds = true;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  mainWindow.setBounds(area);
  adjustingBounds = false;
  mainWindow.__filled = true;
  reportMaximized();
}

// Fills whichever display the window is currently on. Reads the display BEFORE
// any unmaximize (which on Windows teleports the window toward the primary
// monitor), so the fill always lands on the monitor the user put it on.
function fillWorkArea() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  applyFill(currentWorkArea());
}

/** Returns a filled window to its previous floating size, kept on screen. */
function restoreBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  let saved = mainWindow.__restoreBounds;
  if (!saved || saved.x === undefined) {
    const area = currentWorkArea();
    const width = Math.min(1280, area.width);
    const height = Math.min(820, area.height);
    saved = {
      x: area.x + Math.round((area.width - width) / 2),
      y: area.y + Math.round((area.height - height) / 2),
      width,
      height,
    };
  }
  mainWindow.__filled = false;
  mainWindow.setBounds({
    x: Math.round(saved.x),
    y: Math.round(saved.y),
    width: Math.round(saved.width),
    height: Math.round(saved.height),
  });
  ensureOnScreen(mainWindow);
  reportMaximized();
}

// ------------------------------------------------------------- system tray

let tray = null;
let quitting = false;
// True once Windows tells us the session is ending (log off / shut down /
// restart). While it is set, nothing may cancel a window close or hide to the
// tray — blocking shutdown is exactly what made Windows force-kill Voxara and
// Chromium raise a breakpoint on the way down.
let sessionEnding = false;

// rgbaToPng (raw RGBA -> PNG file bytes, pure Node, no native deps) and
// markIconPng (the Voxara mark drawn from it) now live in ./icon-art, shared
// with build/after-pack.js so the tray icon and the baked-in app icon are
// pixel-for-pixel the same drawing code, not two copies that can drift.

// A standard 5-wide x 7-tall dot-matrix digit font (the same shapes as the
// classic HD44780/Adafruit_GFX character set) — a 3x5 first attempt at this
// packed small enough to make out "1" from "3" from "8" at 32px, but proved
// genuinely ambiguous (a "3" read as a mirrored "E"). This one is a known
// quantity.
const DIGIT_FONT = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
};

/**
 * A small red circular badge with the unread count on it, exactly like
 * A taskbar badge — Electron has no built-in way to draw one, and
 * pulling in a canvas library (or a whole hidden BrowserWindow) for one
 * number felt like a lot, so it's the same hand-rolled-PNG approach as the
 * tray icon above, just with a couple of glyphs stamped into it.
 */
function badgeIconPng(count) {
  const size = 32;
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 1;
  const setPixel = (x, y, [pr, pg, pb, pa]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const o = Math.floor(y) * stride + 1 + Math.floor(x) * 4;
    raw[o] = pr; raw[o + 1] = pg; raw[o + 2] = pb; raw[o + 3] = pa;
  };
  // The red circle.
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const inCircle = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r;
      setPixel(x, y, inCircle ? [237, 66, 69, 255] : [0, 0, 0, 0]); // badge red
    }
  }
  // One glyph per digit (plus "+" for 100 and up), stamped in white. Sized so
  // the glyph block's own corners stay inside the circle, not just the
  // square canvas — a badge is round, and a square-fitted digit would poke
  // little white corners out past the red.
  const text = count > 99 ? '9+' : String(Math.max(1, count));
  const scale = text.length > 1 ? 2 : 3;
  const glyphW = 5 * scale;
  const glyphH = 7 * scale;
  const gap = text.length > 1 ? 2 : 0;
  const totalW = glyphW * text.length + gap * (text.length - 1);
  let startX = Math.round((size - totalW) / 2);
  const startY = Math.round((size - glyphH) / 2);
  for (const ch of text) {
    const rows = DIGIT_FONT[ch] || DIGIT_FONT['9'];
    for (let ry = 0; ry < 7; ry += 1) {
      for (let rx = 0; rx < 5; rx += 1) {
        if (rows[ry][rx] !== '1') continue;
        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            setPixel(startX + rx * scale + sx, startY + ry * scale + sy, [255, 255, 255, 255]);
          }
        }
      }
    }
    startX += glyphW + gap;
  }
  return rgbaToPng(size, raw);
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function setupTray() {
  try {
    const icon = nativeImage.createFromBuffer(markIconPng(32));
    tray = new Tray(icon);
    tray.setToolTip('Voxara');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Voxara', click: showWindow },
      { type: 'separator' },
      { label: 'Quit Voxara', click: () => { quitting = true; app.quit(); } },
    ]));
    // A left-click on the tray toggles the window (Windows-friendly).
    tray.on('click', () => {
      if (mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()) mainWindow.hide();
      else showWindow();
    });
  } catch (err) {
    // A platform without a system tray (some Linux setups) — no problem, the
    // app runs fine without it.
    console.warn('[pulse] system tray unavailable:', err.message);
    tray = null;
  }
}

function createWindow() {
  const settings = readSettings();
  const bounds = fitToScreen(settings.windowBounds || {});

  // Fill the screen when the last session was maximized, and on a first run so
  // the app opens usably large rather than as a small floating window. Doing it
  // through the initial bounds — not a setBounds after show — means the window
  // is realised already filled, which some window managers otherwise ignore.
  const startFilled = bounds.maximized || !settings.windowBounds;
  const openBounds = startFilled ? screen.getPrimaryDisplay().workArea : bounds;

  mainWindow = new BrowserWindow({
    width: openBounds.width,
    height: openBounds.height,
    x: openBounds.x,
    y: openBounds.y,
    minWidth: 820,
    minHeight: 560,
    show: false,
    frame: false,
    // Used to be `transparent: true` so the sign-in card floated on the real
    // desktop behind it — looked good, but a genuinely transparent window is
    // one of the more fragile things you can ask Windows' compositor for:
    // restoring or alt-tabbing back to one can show a bare black frame for a
    // beat while DWM rebuilds its surface, which is exactly the flicker that
    // survived two other fixes aimed at the renderer side of this instead.
    // A plain opaque window doesn't have that failure mode at all — the
    // sign-in screen now sits on its own solid background (see auth.css)
    // rather than on the desktop.
    backgroundColor: '#0d0d0fff',
    title: 'Voxara',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only uses contextBridge + ipcRenderer, both of which work
      // sandboxed, so there is no reason to leave Node reachable from it.
      sandbox: true,
      spellcheck: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // Chromium throttles a hidden/occluded window's rendering to save
      // power, then has to "wake it back up" when it's shown again — the
      // window reappears before that catch-up frame is ready, showing its
      // plain background color for a beat first. That's the flicker on
      // restore/alt-tab-back; disabling the throttling keeps the renderer
      // live the whole time; a chat app wants that anyway, to stay current
      // in the background.
      backgroundThrottling: false,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadURL(`${APP_ORIGIN}/index.html`);

  // Minimize-to-tray: when the setting is on, closing the window hides it to the
  // tray instead of quitting. A real quit (tray menu, or OS shutdown) sets
  // `quitting` first so it still exits.
  mainWindow.on('close', (event) => {
    if (!quitting && !sessionEnding && tray && readSettings().minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // The window was created at work-area size, so mark it filled and remember a
  // sensible floating size for when it is later restored.
  if (startFilled) {
    mainWindow.__filled = true;
    mainWindow.__restoreBounds = bounds.maximized ? bounds : null;
  }

  mainWindow.once('ready-to-show', () => {
    // Asking for good bounds is not the same as getting them: a window manager
    // can place the window where it likes. Check what we actually got and
    // correct it, otherwise the title bar or composer can sit off-screen.
    if (mainWindow.__filled) fillWorkArea();
    else ensureOnScreen(mainWindow);
    mainWindow.show();
    // Some window managers place the window when it is shown, ignoring the
    // bounds we asked for — so check again once it is actually on screen.
    mainWindow.once('show', () => setTimeout(() => {
      if (mainWindow?.__filled) fillWorkArea();
      else ensureOnScreen(mainWindow);
    }, 30));
    // Offer any newer build shortly after launch, once the window has settled.
    // The UI is in the app now (a styled card, a progress bar) rather than a
    // native OS dialog, so main just tells the renderer an update is ready.
    setTimeout(() => checkAndOfferUpdate(true), 4000);
  });

  // Coming back to the app is a natural moment to notice a new build (throttled
  // to hourly inside checkAndOfferUpdate).
  mainWindow.on('focus', () => checkAndOfferUpdate());

  // Double-clicking the draggable title bar asks Windows to maximize natively,
  // which overflows a frameless window and clips the bar. Convert any native
  // maximize we did not initiate into a clean work-area fill.
  mainWindow.on('maximize', () => {
    winlog('native maximize event');
    if (!adjustingBounds && !mainWindow.isMinimized()) fillWorkArea();
  });
  mainWindow.on('enter-full-screen', reportMaximized);
  mainWindow.on('leave-full-screen', reportMaximized);

  // Coming back from minimize is where the frame and the renderer viewport can
  // disagree (a display change while minimized, a DPI switch, a game changing
  // resolution) — the window then draws content larger than itself and the
  // composer is clipped away. The heal MEASURES the two and, only when they
  // differ, forces genuine resizes spaced across ticks — a same-tick
  // shrink-and-revert gets coalesced by Windows into no resize at all.
  let healing = false;
  let lastHeal = 0;
  async function healViewport(reason) {
    if (healing || !mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    if (Date.now() - lastHeal < 1500) return;
    lastHeal = Date.now();
    healing = true;
    try {
      const frame = mainWindow.getContentBounds();
      const view = await mainWindow.webContents.executeJavaScript(
        '({ w: window.innerWidth, h: window.innerHeight })', true,
      );
      // A couple of pixels is DPI rounding, not a broken viewport. Only a real
      // desync is worth the resize dance — which is visible as a blink, so it
      // must never run on an ordinary alt-tab back to the app.
      const off = Math.abs(frame.width - view.w) > 8 || Math.abs(frame.height - view.h) > 8;
      winlog(`heal(${reason}) frame=${frame.width}x${frame.height} view=${view.w}x${view.h} desync=${off}`);
      if (!off && reason === 'focus') return;
      if (off) {
        const b = mainWindow.getBounds();
        adjustingBounds = true;
        mainWindow.setBounds({ ...b, height: Math.max(560, b.height - 2) });
        await new Promise((r) => setTimeout(r, 120));
        mainWindow.setBounds(b);
        adjustingBounds = false;
        await new Promise((r) => setTimeout(r, 80));
      }
      mainWindow.__pendingFit = false;
      if (mainWindow.__filled) fillWorkArea();
      else ensureOnScreen(mainWindow);
      if (off) {
        // Repaint and re-measure too — the frame being fixed does not mean
        // the presented surface or the page layout followed.
        mainWindow.webContents.invalidate();
        mainWindow.webContents.send('window:viewport-nudge');
        winlog(`heal(${reason}) applied`);
      }
    } catch (err) {
      adjustingBounds = false;
      winlog(`heal(${reason}) failed: ${err.message}`);
    } finally {
      healing = false;
    }
  }
  mainWindow.on('minimize', () => winlog('minimize'));
  mainWindow.on('hide', () => { winlog('hide'); mainWindow.__wasHidden = true; });

  // Coming back from minimize (or the tray) is where this window has
  // repeatedly come back wrong on real Windows machines: frame smaller than
  // the rendered content, composer cut off. Three bounds-only fixes failed,
  // and the measurements say why — the frame and window.innerHeight can agree
  // while the screen still shows content drawn for a different size. So the
  // frame is only one of three layers that can be stale, and this path now
  // resets all of them:
  //   1. bounds  — two genuine, spaced resizes to known-good values (a
  //      same-tick shrink-and-revert gets coalesced by Windows into nothing),
  //      re-asserted again after the restore animation has surely finished;
  //   2. compositor — webContents.invalidate(): a transparent frameless
  //      window on Windows is known to present a stale surface after
  //      minimize/restore or a DPI change, which looks exactly like this bug;
  //   3. renderer layout — a viewport-nudge event tells the page to re-measure
  //      innerHeight and drive its layout from that pixel value, sidestepping
  //      any stale vh resolution.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let hardRestoring = false;
  async function hardRestore(reason) {
    if (hardRestoring || !mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    hardRestoring = true;
    try {
      const target = mainWindow.__filled
        ? currentWorkArea()
        : (mainWindow.__lastGood || fitToScreen(readSettings().windowBounds || {}));
      winlog(`hard-restore(${reason}) to ${JSON.stringify(target)}`);
      adjustingBounds = true;
      const at = mainWindow.getBounds();
      mainWindow.setBounds({
        x: target.x ?? at.x,
        y: target.y ?? at.y,
        width: Math.max(820, (target.width || 1280) - 2),
        height: Math.max(560, (target.height || 820) - 2),
      });
      await sleep(120);
      if (mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
      const want = mainWindow.__filled ? currentWorkArea() : {
        x: target.x ?? at.x,
        y: target.y ?? at.y,
        width: Math.max(820, target.width || 1280),
        height: Math.max(560, target.height || 820),
      };
      mainWindow.setBounds(want);
      adjustingBounds = false;
      reportMaximized();
      mainWindow.webContents.invalidate();
      mainWindow.webContents.send('window:viewport-nudge');
      // Windows can clobber bounds applied during the restore animation.
      // Check once more well after it has finished, then repaint again.
      await sleep(700);
      if (mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
      const now = mainWindow.getBounds();
      const later = mainWindow.__filled ? currentWorkArea() : want;
      const drifted = Math.abs(now.width - later.width) > 2 || Math.abs(now.height - later.height) > 2;
      if (drifted) {
        winlog(`hard-restore(${reason}) drifted to ${now.width}x${now.height}, reasserting ${later.width}x${later.height}`);
        adjustingBounds = true;
        mainWindow.setBounds(later);
        adjustingBounds = false;
      }
      mainWindow.webContents.invalidate();
      mainWindow.webContents.send('window:viewport-nudge');
      winlog(`hard-restore(${reason}) done${drifted ? ' (reasserted)' : ''}`);
    } catch (err) {
      winlog(`hard-restore(${reason}) failed: ${err.message}`);
    } finally {
      adjustingBounds = false;
      hardRestoring = false;
    }
  }

  mainWindow.on('restore', () => {
    winlog('restore');
    setTimeout(() => void hardRestore('restore'), 100);
  });
  // Reappearing from the tray is a hide→show, not a minimize→restore: no
  // 'restore' event ever fires, so this path used to skip the hard restore
  // entirely and rely on a measurement that lies on the affected machines.
  mainWindow.on('show', () => {
    winlog('show');
    const fromHidden = mainWindow.__wasHidden;
    mainWindow.__wasHidden = false;
    if (fromHidden) setTimeout(() => void hardRestore('show'), 100);
    else setTimeout(() => void healViewport('show'), 100);
  });
  // Focus fires on every return to the app — cheap, throttled, measurement-gated.
  mainWindow.on('focus', () => setTimeout(() => void healViewport('focus'), 150));

  // A monitor being unplugged or rescaled can leave the window stranded.
  const onDisplayChange = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.__filled) fillWorkArea();
    else ensureOnScreen(mainWindow);
  };
  screen.on('display-metrics-changed', onDisplayChange);
  screen.on('display-removed', onDisplayChange);
  mainWindow.on('closed', () => {
    screen.removeListener('display-metrics-changed', onDisplayChange);
    screen.removeListener('display-removed', onDisplayChange);
  });

  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    const next = readSettings();
    // A filled window records maximized plus the floating size to restore to;
    // a first run has no floating size yet, so default one rather than saving
    // a bare flag that loses the size entirely.
    next.windowBounds = mainWindow.__filled
      ? { width: 1280, height: 820, ...(mainWindow.__restoreBounds || next.windowBounds || {}), maximized: true }
      : { ...mainWindow.getBounds(), maximized: false };
    // The restore hammer needs a known-good floating size it can trust more
    // than whatever Windows hands back after un-minimizing.
    if (!mainWindow.__filled) mainWindow.__lastGood = mainWindow.getBounds();
    writeSettings(next);
    console.log('[pulse] window bounds saved:', JSON.stringify(next.windowBounds));
  };
  mainWindow.on('close', saveBounds);

  // Windows is logging off, shutting down or restarting. We get a short,
  // OS-granted window to bow out — so quit immediately and cleanly rather than
  // hiding to the tray (which cancels the close, blocks the shutdown, and gets
  // us force-killed mid-teardown → the "Voxara is preventing shutdown" screen
  // plus a Chromium breakpoint dialog). Save bounds, drop the tray, and exit
  // now while we still can.
  const onSessionEnd = () => {
    winlog('session-end');
    sessionEnding = true;
    quitting = true;
    try { saveBounds(); } catch { /* best effort under a deadline */ }
    try { tray?.destroy(); } catch { /* ignore */ }
    app.exit(0);
  };
  mainWindow.on('session-end', onSessionEnd);
  // Also save as the window settles after a move or resize: the updater quits
  // with app.exit(), which never fires 'close', and relaunching with stale
  // bounds is exactly how an update appears to shrink the window. No
  // adjustingBounds guard here: the debounce fires well after the programmatic
  // move has finished, when __filled already holds the right answer — and the
  // guard was exactly why "maximized" never got recorded.
  let saveBoundsTimer = null;
  const saveBoundsSoon = () => {
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(saveBounds, 600);
  };
  mainWindow.on('resize', saveBoundsSoon);
  mainWindow.on('move', saveBoundsSoon);

  // ------- Aero-Snap-style drag behaviour (frameless, so we do it ourselves) -------

  // Grabbing a filled window to drag it restores it to its floating size, kept
  // under the cursor — the way Windows frees a maximised window when you drag it.
  mainWindow.on('will-move', (event) => {
    if (adjustingBounds || !mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.__filled) return;
    event.preventDefault();
    const cursor = screen.getCursorScreenPoint();
    const cur = mainWindow.getBounds();
    const saved = mainWindow.__restoreBounds && mainWindow.__restoreBounds.x !== undefined
      ? mainWindow.__restoreBounds
      : (() => { const a = currentWorkArea(); return { width: Math.min(1280, a.width), height: Math.min(820, a.height) }; })();
    const w = Math.round(saved.width);
    const h = Math.round(saved.height);
    // Keep the cursor at the same horizontal fraction of the title bar so the
    // window stays under the pointer as it shrinks.
    const frac = Math.min(0.9, Math.max(0.1, cur.width ? (cursor.x - cur.x) / cur.width : 0.5));
    adjustingBounds = true;
    mainWindow.__filled = false;
    mainWindow.setBounds({ x: Math.round(cursor.x - w * frac), y: Math.max(0, Math.round(cursor.y - 16)), width: w, height: h });
    adjustingBounds = false;
    reportMaximized();
  });

  // Dropping the window at the very top of a monitor fills that monitor.
  mainWindow.on('moved', () => {
    if (adjustingBounds || !mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    if (mainWindow.__filled) return;
    const cursor = screen.getCursorScreenPoint();
    const disp = screen.getDisplayNearestPoint(cursor);
    if (cursor.y <= disp.workArea.y + 6) applyFill(disp.workArea);
  });
  // And once at startup, so even a session with no interaction at all leaves
  // an accurate record for the next launch.
  setTimeout(saveBoundsSoon, 3000);

  // Keep DevTools reachable even though there is no menu bar.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const key = (input.key || '').toLowerCase();
    if (input.type !== 'keyDown') return;
    // DevTools is a development affordance; packaged builds should not ship it.
    if (IS_DEV && (key === 'f12' || (input.control && input.shift && key === 'i'))) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
    if (input.control && key === 'r' && IS_DEV) {
      mainWindow.webContents.reload();
      event.preventDefault();
    }
  });

  // External links open in the real browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_ORIGIN)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------- ipc

ipcMain.handle('config:get', () => ({
  platform: process.platform,
  version: app.getVersion(),
  isDev: IS_DEV,
  defaultServerUrl: HOME_SERVER_URL,
  settings: readSettings(),
}));

// --- updates ---------------------------------------------------------------

// Always the baked-in server. Reading a stored address here would let one
// stale settings file keep an install pointed at a server that no longer
// exists, with no way to correct it from the UI.
const updateServerUrl = () => HOME_SERVER_URL;

// Auto-update offers: check on startup AND periodically / on focus, so an app
// left open for days still notices a new build. We only surface the card once
// per version so it never nags repeatedly for the same release.
let lastOfferedVersion = null;
let lastCheckAt = 0;
async function checkAndOfferUpdate(force = false) {
  const now = Date.now();
  if (!force && now - lastCheckAt < 60 * 60 * 1000) return; // at most hourly unless forced
  lastCheckAt = now;
  try {
    const result = await updater.checkForUpdates(updateServerUrl());
    if (result?.status === 'available' && result.version !== lastOfferedVersion) {
      lastOfferedVersion = result.version;
      mainWindow?.webContents.send('update:available', {
        version: result.version, notes: result.notes || '', current: app.getVersion(),
      });
    } else if (result?.status !== 'available') {
      console.log(`[pulse] update check: ${result?.status || 'no result'}`
        + (result?.version ? ` (server has ${result.version})` : '')
        + ` — running ${app.getVersion()}`);
    }
  } catch (err) {
    console.warn('[pulse] update check failed:', err.message);
  }
}

// Re-check every few hours for long-running windows.
const updatePoll = setInterval(() => checkAndOfferUpdate(), 3 * 60 * 60 * 1000);
updatePoll.unref?.();

ipcMain.handle('update:check', async () => {
  try {
    return await updater.checkForUpdates(updateServerUrl());
  } catch (err) {
    return { status: 'error', message: err.message };
  }
});

ipcMain.handle('update:install', async () => {
  try {
    return await updater.downloadAndApply((progress) => {
      // Mirror progress onto the taskbar button as well as the in-app bar.
      if (!mainWindow?.isDestroyed?.()) {
        const fraction = progress.phase === 'downloading'
          ? Math.max(0.02, (progress.percent || 0) / 100)
          : 1;
        mainWindow?.setProgressBar?.(fraction);
      }
      mainWindow?.webContents.send('update:progress', progress);
    });
  } catch (err) {
    mainWindow?.setProgressBar?.(-1);
    return { status: 'error', message: err.message };
  }
});

ipcMain.handle('update:version', () => app.getVersion());

ipcMain.handle('update:changelog', async () => {
  try {
    return await updater.fetchChangelog(updateServerUrl());
  } catch (err) {
    return { moreUrl: '', entries: [], error: err.message };
  }
});

ipcMain.handle('settings:set', (_event, patch) => {
  const settings = { ...readSettings(), ...(patch || {}) };
  writeSettings(settings);
  return settings;
});

ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:toggle-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.__filled) {
    // THE reported click. Diagnostics from a real scale-1.5 Windows machine
    // showed this path shrinking the frame correctly while the page kept a
    // layout for the filled size — and it had none of the restore medicine.
    // Now it gets all of it: a second genuine resize a beat later, a
    // compositor repaint, and a renderer re-measure + overflow self-check.
    winlog('toggle: restore down');
    restoreBounds();
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.__filled || mainWindow.isMinimized()) return;
      const want = mainWindow.getBounds();
      adjustingBounds = true;
      mainWindow.setBounds({ ...want, height: Math.max(560, want.height - 2) });
      adjustingBounds = false;
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed() || mainWindow.__filled || mainWindow.isMinimized()) return;
        adjustingBounds = true;
        mainWindow.setBounds(want);
        adjustingBounds = false;
        mainWindow.webContents.invalidate();
        mainWindow.webContents.send('window:viewport-nudge');
        winlog('toggle: restore down settled');
      }, 120);
    }, 100);
  } else {
    winlog('toggle: fill');
    fillWorkArea();
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
      mainWindow.webContents.invalidate();
      mainWindow.webContents.send('window:viewport-nudge');
    }, 100);
  }
});
ipcMain.on('window:close', () => mainWindow?.close());
ipcMain.handle('window:is-maximized', () => Boolean(mainWindow?.__filled));


// Everything the main process knows about the window, plus the recent
// window.log tail. The renderer pairs this with its own measurements and
// ships the bundle to the server after every restore, so the recurring
// "clipped after minimize" bug carries its own evidence off machines no
// debugger can reach.
ipcMain.handle('window:diag', () => {
  let logTail = '';
  try {
    logTail = fs.readFileSync(path.join(app.getPath('userData'), 'window.log'), 'utf8').slice(-6000);
  } catch { /* no log yet */ }
  let bounds = null;
  let contentBounds = null;
  let display = null;
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      bounds = mainWindow.getBounds();
      contentBounds = mainWindow.getContentBounds();
      const d = screen.getDisplayMatching(bounds);
      display = { scale: d.scaleFactor, size: d.size, workArea: d.workArea };
    }
  } catch { /* pre-ready */ }
  return {
    version: app.getVersion(),
    platform: `${process.platform} ${require('node:os').release()}`,
    bounds,
    contentBounds,
    display,
    filled: Boolean(mainWindow?.__filled),
    logTail,
  };
});

ipcMain.on('app:flash', () => {
  if (mainWindow && !mainWindow.isFocused()) mainWindow.flashFrame(true);
});

// --- in-game voice overlay --------------------------------------------------
// A small transparent, click-through, always-on-top window in a screen corner
// that shows who is in your voice call and who is talking, so you can see it
// over a game (windowed or borderless fullscreen; exclusive fullscreen games
// draw over everything and hide it, like every overlay that does not inject
// into the game). The renderer decides when it should be visible and what it
// shows; this side only owns the window.
let overlayWindow = null;
const OVERLAY_WIDTH = 300;
const OVERLAY_MARGIN = 20;

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  overlayWindow = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: 120,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    title: 'Voxara overlay',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  // Above fullscreen-ish windows, on every desktop, and never catching a click.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  try { overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* not everywhere */ }
  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.setMenu(null);
  overlayWindow.loadURL(`${APP_ORIGIN}/overlay.html`);
  overlayWindow.on('closed', () => { overlayWindow = null; });
  return overlayWindow;
}

/** Corner placement on the display the main window is on (the game is usually there too). */
function placeOverlay(corner, height) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  let display;
  try {
    display = (mainWindow && !mainWindow.isDestroyed()) ? screen.getDisplayMatching(mainWindow.getBounds()) : screen.getPrimaryDisplay();
  } catch { display = screen.getPrimaryDisplay(); }
  const area = display.bounds; // not workArea: a borderless game covers the taskbar too
  const h = Math.max(48, Math.min(Math.round(height) || 120, area.height - OVERLAY_MARGIN * 2));
  const right = /right/.test(corner);
  const bottom = /bottom/.test(corner);
  overlayWindow.setBounds({
    x: right ? area.x + area.width - OVERLAY_WIDTH - OVERLAY_MARGIN : area.x + OVERLAY_MARGIN,
    y: bottom ? area.y + area.height - h - OVERLAY_MARGIN : area.y + OVERLAY_MARGIN,
    width: OVERLAY_WIDTH,
    height: h,
  });
}

// { visible, corner, title, rows: [{ id, name, avatarUrl, color, speaking, muted, sharing }] }
ipcMain.on('overlay:set', (_event, state) => {
  if (!state || typeof state !== 'object') return;
  if (!state.visible) {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
    return;
  }
  const win = createOverlayWindow();
  const rows = Array.isArray(state.rows) ? state.rows.slice(0, 12) : [];
  placeOverlay(String(state.corner || 'top-left'), 14 + 30 + rows.length * 40 + 14);
  const payload = { title: String(state.title || '').slice(0, 60), corner: String(state.corner || 'top-left'), rows: rows.map((r) => ({
    id: String(r.id || ''), name: String(r.name || '').slice(0, 40), avatarUrl: typeof r.avatarUrl === 'string' && /^https:/.test(r.avatarUrl) ? r.avatarUrl : null,
    color: typeof r.color === 'string' ? r.color.slice(0, 30) : null, speaking: Boolean(r.speaking), muted: Boolean(r.muted), sharing: Boolean(r.sharing),
  })) };
  const send = () => { if (win && !win.isDestroyed()) win.webContents.send('overlay:state', payload); };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send); else send();
  if (!win.isVisible()) win.showInactive();
});

// Deep links (voxara://join/<code>): parsed here, acted on by the renderer.
let pendingDeepLink = process.argv.find((a) => /^voxara:\/\//i.test(a)) || null;
function handleDeepLink(url) {
  if (!url) return;
  // Kept until the renderer asks for it, so a link that arrives before the
  // page is ready (or before sign-in) is not lost.
  pendingDeepLink = url;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:deep-link', { url });
}
ipcMain.handle('app:deep-link-pending', () => { const url = pendingDeepLink; pendingDeepLink = null; return url; });

ipcMain.on('app:notify', (_event, { title, body, channelId } = {}) => {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: String(title || 'Voxara'),
    body: String(body || '').slice(0, 240),
    silent: false,
  });
  notification.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.send('app:notification-click', { channelId });
  });
  notification.show();
});

ipcMain.on('app:badge', (_event, count) => {
  const total = Number(count) || 0;
  if (process.platform === 'darwin') {
    app.setBadgeCount(total);
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    // Windows has no dock badge; setOverlayIcon draws directly on the
    // taskbar button instead — the same little numbered circle chat apps
    // shows — and the title is what actually shows in the taskbar preview.
    mainWindow.setTitle(total > 0 ? `Voxara (${total})` : 'Voxara');
    try {
      mainWindow.setOverlayIcon(
        total > 0 ? nativeImage.createFromBuffer(badgeIconPng(total)) : null,
        total > 0 ? `${total} unread` : '',
      );
    } catch { /* platform without overlay-icon support (e.g. Linux) */ }
  }
  // Reflect unread count in the tray tooltip too.
  tray?.setToolTip(total > 0 ? `Voxara — ${total} unread` : 'Voxara');
});

ipcMain.on('app:open-external', (_event, url) => {
  if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url));
});

// The renderer's own navigator.clipboard.writeText() fails here: it needs
// the 'clipboard-write' permission, and the handler below only ever grants
// CALL_PERMS — so every "Copy" button was silently rejected. Electron's
// native clipboard module isn't gated by that Permissions API at all.
// Resolves to whether the text actually landed. On Windows the system
// clipboard is a shared lock: another app (clipboard managers especially)
// holding it makes writeText a silent no-op, so retry briefly and then read
// back rather than assuming. The renderer falls back to an in-page copy
// when this reports false.
ipcMain.handle('clipboard:write-text', async (_event, text) => {
  const value = String(text ?? '');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      clipboard.writeText(value);
      if (clipboard.readText() === value) return true;
    } catch { /* locked — retry */ }
    await new Promise((resolve) => setTimeout(resolve, 60 * (attempt + 1)));
  }
  return false;
});

// ------------------------------------------------------ local game detection
// Steam's own presence API (see server/src/steam.js) only ever tells friends
// about a Steam-launched game. Everything else — Minecraft, Roblox, anything
// with its own launcher — needs the same trick other chat apps use: watch the
// running process list for a small, hand-maintained set of known games. This
// only runs on Windows, the one platform Voxara ships for.
//
// Two-tier scan so the common case stays cheap: `tasklist` alone (no command
// lines) catches every game below except Minecraft, whose Java Edition
// process is just "javaw.exe" — indistinguishable from any other Java app by
// name alone. Only when javaw/java is actually running do we pay for the
// heavier WMI query that reads its command line, so a false "Playing
// Minecraft" never gets reported for an unrelated Java program.
const GAME_SIGNATURES = [
  { name: 'Roblox', exe: /^robloxplayerbeta\.exe$/i },
  { name: 'Roblox Studio', exe: /^robloxstudiobeta\.exe$/i },
  { name: 'Minecraft', exe: /^minecraft\.windows\.exe$/i }, // Bedrock / Microsoft Store
  { name: 'Fortnite', exe: /^fortniteclient-win64-shipping\.exe$/i },
  { name: 'VALORANT', exe: /^valorant-win64-shipping\.exe$/i },
  { name: 'League of Legends', exe: /^league of legends\.exe$/i },
  { name: 'Genshin Impact', exe: /^genshinimpact\.exe$|^yuanshen\.exe$/i },
  { name: 'Among Us', exe: /^among us\.exe$/i },
  { name: 'Apex Legends', exe: /^r5apex\.exe$/i },
  { name: 'Call of Duty', exe: /^cod\.exe$|^codwarzone\.exe$/i },
  { name: 'Overwatch 2', exe: /^overwatch\.exe$/i },
  { name: 'Rocket League', exe: /^rocketleague\.exe$/i },
  { name: 'Grand Theft Auto V', exe: /^gta5(_enhanced)?\.exe$/i },
];
const JAVA_EXE = /^javaw?\.exe$/i;

// execFile (argv array, no shell) rather than exec (one shell-parsed string)
// — a nested-quoting mistake in a nice-looking exec() string is exactly how
// the Windows updater's apply script shipped broken once already; passing
// each argument separately sidesteps that whole class of bug.
function runFile(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

/** Process names only — cheap, run every tick. */
async function listProcessNames() {
  const out = await runFile('tasklist', ['/fo', 'csv', '/nh']);
  return out.split(/\r?\n/)
    .map((line) => line.match(/^"([^"]+)"/)?.[1])
    .filter(Boolean);
}

/** Only called when a java(w).exe is actually running: confirms it's really
 * Minecraft by checking whether its command line mentions it. */
async function javaIsMinecraft() {
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'javaw.exe' -or $_.Name -eq 'java.exe' } "
    + '| Select-Object -ExpandProperty CommandLine';
  const out = await runFile('powershell', ['-NoProfile', '-Command', script]);
  return /minecraft/i.test(out);
}

async function scanForLocalGame() {
  if (process.platform !== 'win32') return null;
  const names = await listProcessNames();
  for (const sig of GAME_SIGNATURES) {
    if (names.some((n) => sig.exe.test(n))) return sig.name;
  }
  if (names.some((n) => JAVA_EXE.test(n)) && await javaIsMinecraft()) return 'Minecraft';
  return null;
}

let lastDetectedGame = null;
// The renderer only starts listening for 'game:detected' once it's signed in
// and mounted, which can easily be later than this module's first scan tick
// (fired right at launch) — a push sent before anyone was listening is just
// lost. So the renderer also pulls the current value once when it mounts.
ipcMain.handle('game:current', () => lastDetectedGame);

function startGameDetection() {
  if (process.platform !== 'win32') return; // nothing to scan elsewhere
  const tick = async () => {
    const game = await scanForLocalGame().catch(() => null);
    if (game === lastDetectedGame) return;
    lastDetectedGame = game;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('game:detected', game);
  };
  tick();
  setInterval(tick, 15_000).unref?.();
}

// -------------------------------------------------------------------- boot

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    // A voxara:// link opened while the app is already running arrives here
    // (Windows and Linux hand it over as an argument to the second instance).
    handleDeepLink(argv.find((a) => /^voxara:\/\//i.test(a)));
  });
  app.on('open-url', (event, url) => { event.preventDefault(); handleDeepLink(url); });

  // Fires for the WebSocket, image and update traffic alike.
  app.on('certificate-error', (event, _webContents, url, _error, certificate, callback) => {
    handleCertificate(event, url, certificate, callback);
  });

  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark';
    // Windows toasts need the app's identity to match the installed shortcut.
    app.setAppUserModelId('com.pulse.chat');
    // voxara://join/<code> from invite pages on the website.
    try { app.setAsDefaultProtocolClient('voxara'); } catch { /* not supported here */ }
    registerAppProtocol();
    // Screen sharing: answer getDisplayMedia() requests. Electron needs a source
    // handler or the call throws. We hand back the primary screen; the OS picker
    // is used where the platform supports it.
    // Let the app's own pages use the microphone, camera and screen capture.
    // The renderer is our trusted app://pulse origin, so grant these outright.
    try {
      const CALL_PERMS = new Set(['media', 'display-capture', 'notifications']);
      session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
        callback(CALL_PERMS.has(permission));
      });
      session.defaultSession.setPermissionCheckHandler((wc, permission) => CALL_PERMS.has(permission));
    } catch { /* older Electron — defaults apply */ }

    // A fresh, larger snapshot of one capture source, for the share picker's
    // preview pane. Cheap enough to poll every second or so while the picker is open.
    ipcMain.handle('screen:preview', async (_e, id) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 960, height: 540 } });
        const src = sources.find((x) => x.id === id);
        return src ? src.thumbnail.toDataURL() : null;
      } catch { return null; }
    });

    try {
      session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
        desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 640, height: 360 },
          fetchWindowIcons: true,
        }).then((sources) => {
          if (!sources.length) { callback(undefined); return; }
          // Hand the page a lightweight list to draw a picker from.
          const list = sources.map((src) => ({
            id: src.id,
            name: src.name,
            kind: src.id.startsWith('screen') ? 'screen' : 'window',
            thumb: src.thumbnail.toDataURL(),
          }));
          const onChosen = (_e, id, opts) => {
            ipcMain.removeListener('screen:chosen', onChosen);
            const chosen = sources.find((s) => s.id === id);
            if (!chosen) { callback(undefined); return; } // cancelled
            // System audio ("what you hear") is captured as a loopback of the
            // output device; Chromium offers that on Windows only.
            const wantAudio = Boolean(opts && opts.audio) && process.platform === 'win32';
            callback(wantAudio ? { video: chosen, audio: 'loopback' } : { video: chosen });
          };
          ipcMain.on('screen:chosen', onChosen);
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('screen:choose', list);
          else callback({ video: sources[0] });
        }).catch(() => callback(undefined));
      }, { useSystemPicker: false });
    } catch { /* older Electron without the handler — web build still works */ }

    createWindow();
    setupTray();
    startGameDetection();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => { quitting = true; if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy(); });
}
