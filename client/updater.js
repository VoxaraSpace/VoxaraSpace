'use strict';

/**
 * Self-update for the portable Windows build.
 *
 * The app cannot overwrite its own running executable. An installer-based
 * install hands over to the NSIS installer itself (/S --force-run), which
 * closes the app, installs, and relaunches — no scripting involved. A portable
 * (zip) install uses a detached cmd.exe batch that waits for this process to
 * exit, extracts the new build over the install directory (tar + robocopy),
 * and starts the app again. PowerShell is deliberately not used anywhere:
 * real-world policies and antivirus block it, which stranded updates.
 *
 * Everything is served by the Voxara server the client is already talking to:
 *   GET /update/latest.json   -> { version, url, sha256, size, notes }
 *   GET /update/<file>.zip    -> the build
 */

const { app, dialog, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CHECK_TIMEOUT_MS = 8000;

let cached = null; // the update we have found and verified, if any
let pinLookup = () => null; // set by main.js so we can honour the same pins

/** Lets the host app supply the trust store used for pinned certificates. */
function usePinStore(lookup) {
  pinLookup = typeof lookup === 'function' ? lookup : () => null;
}

// A rollback "hold": after going back on purpose, the newer build is not
// offered again until a release newer than the one held off arrives, or a
// security floor makes updating required. { serial, untilSerial } or null.
let holdStore = { get: () => null, set: () => {} };
function useHoldStore(store) { if (store && typeof store.get === 'function') holdStore = store; }

/**
 * Node does not consult Chromium's certificate handling. A development server
 * on this machine (the only kind with a self-issued certificate) is verified
 * against the pin the window recorded for it; the production server presents
 * a public-CA certificate and is validated normally.
 */
function requestOptions(url) {
  if (!url.startsWith('https:')) return {};
  const { host } = new URL(url);
  const pinned = pinLookup(host);
  // No pin recorded means a host with a real, publicly trusted certificate
  // (production): Node's normal validation applies, which is the stricter
  // check. A pin only exists for a self-issued certificate on localhost.
  if (!pinned) return { agent: new https.Agent({ keepAlive: false }) };
  return {
    rejectUnauthorized: false,
    checkServerIdentity: () => undefined,
    // A resumed TLS session skips the handshake, and then the peer
    // certificate is not available to inspect. Disabling the session cache
    // forces a full handshake so every request can be verified.
    agent: new https.Agent({ maxCachedSessions: 0, keepAlive: false }),
    __verifyPin: (socket) => {
      const cert = socket.getPeerCertificate();
      if (!cert || !cert.fingerprint256) return 'The server presented no certificate.';
      const offered = `sha256/${Buffer.from(cert.fingerprint256.replace(/:/g, ''), 'hex').toString('base64')}`;
      if (offered !== pinned) return 'The server certificate does not match the pinned one.';
      return null;
    },
  };
}

/** ws://host:port -> http://host:port */
function httpBase(serverUrl) {
  return String(serverUrl || '')
    .replace(/^ws:/i, 'http:')
    .replace(/^wss:/i, 'https:')
    .replace(/\/+$/, '');
}

/** Numeric compare of x.y.z; returns true when `candidate` is newer. */
// The build serial compiled into this copy (client/package.json, written by
// scripts/release.js). Serial beats version string: see release.js.
let localSerial = 0;
try { localSerial = Number(require('./package.json').buildSerial) || 0; } catch { localSerial = 0; }
// Test hook for scripts/release-check.js, which runs this file as an older build would.
if (process.env.PULSE_UPDATER_LOCAL_SERIAL) localSerial = Number(process.env.PULSE_UPDATER_LOCAL_SERIAL) || 0;
function manifestIsNewer(manifest) {
  const remote = Number(manifest?.serial);
  if (Number.isFinite(remote) && remote > 0 && localSerial > 0) return remote > localSerial;
  return isNewer(manifest?.version, app.getVersion());
}

function isNewer(candidate, current) {
  const a = String(candidate).split('.').map(Number);
  const b = String(current).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

function get(url, { json = false } = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const { __verifyPin, ...options } = requestOptions(url);
    const request = client.get(url, options, (res) => {
      if (__verifyPin) {
        const problem = __verifyPin(res.socket);
        if (problem) {
          res.destroy();
          reject(new Error(problem));
          return;
        }
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Server answered ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        try {
          resolve(json ? JSON.parse(body.toString('utf8')) : body);
        } catch (err) {
          reject(new Error(`Malformed response: ${err.message}`));
        }
      });
    });
    request.setTimeout(CHECK_TIMEOUT_MS, () => request.destroy(new Error('Timed out')));
    request.on('error', reject);
  });
}

function download(url, destination, onProgress) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const { __verifyPin, ...options } = requestOptions(url);
    const request = client.get(url, options, (res) => {
      if (__verifyPin) {
        const problem = __verifyPin(res.socket);
        if (problem) {
          res.destroy();
          reject(new Error(problem));
          return;
        }
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Download failed with ${res.statusCode}`));
        return;
      }
      const total = Number(res.headers['content-length']) || 0;
      let received = 0;
      const file = fs.createWriteStream(destination);
      res.on('data', (chunk) => {
        received += chunk.length;
        if (total && onProgress) onProgress(Math.round((received / total) * 100));
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
    });
    request.on('error', reject);
  });
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(await fsp.readFile(file));
  return hash.digest('hex');
}

/**
 * Asks the server what the newest build is.
 * @returns {Promise<{status:string, version?:string, notes?:string, message?:string}>}
 */
async function checkForUpdates(serverUrl) {
  const base = httpBase(serverUrl);
  if (!base) return { status: 'error', message: 'No server address configured.' };

  if (!app.isPackaged) {
    return { status: 'dev', message: 'Updates only apply to the packaged app.' };
  }
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    return { status: 'unsupported', message: 'Self-update is available on Windows and Linux only.' };
  }

  let manifest;
  try {
    manifest = await get(`${base}/update/latest.json`, { json: true });
  } catch (err) {
    return { status: 'error', message: `Could not reach the update server: ${err.message}` };
  }

  if (!manifest?.version || !manifest?.url || !manifest?.sha256) {
    return { status: 'error', message: 'The update server returned an incomplete manifest.' };
  }
  // A hold left over from a rollback is stale once this copy has moved past
  // the build that was held; clear it before anything else.
  const hold = holdStore.get();
  if (hold && localSerial > Number(hold.serial)) holdStore.set(null);
  if (!manifestIsNewer(manifest)) {
    return { status: 'current', version: app.getVersion() };
  }

  // Below the security floor, the update is required and a hold does not apply.
  const required = Number(manifest.minSerial) > 0 && localSerial > 0 && localSerial < Number(manifest.minSerial);
  if (hold && localSerial <= Number(hold.serial) && !required && Number(manifest.serial) <= Number(hold.untilSerial)) {
    return { status: 'held', version: manifest.version, notes: manifest.notes || '' };
  }

  if (process.platform === 'linux' && !manifest.linux?.appImage?.url) {
    return { status: 'current', version: app.getVersion(), message: 'No Linux build of the newer version yet.' };
  }
  cached = { manifest, base };
  return { status: 'available', version: manifest.version, notes: manifest.notes || '', required, manual: process.platform === 'linux' && !linuxAppImagePath() };
}

/**
 * The AppImage this process was started from, or null when Voxara was
 * installed some other way on Linux (the .deb, a distro package). AppImage
 * runtimes export the path; the mount point alone is not enough to write to.
 */
function linuxAppImagePath() {
  if (process.platform !== 'linux') return null;
  const p = process.env.APPIMAGE;
  if (!p || !/\.AppImage$/i.test(p)) return null;
  try { fs.accessSync(p, fs.constants.W_OK); return p; } catch { return null; }
}

/**
 * Linux AppImage: download the new image beside the current one, verify it,
 * swap it in with a rename (the running copy keeps its old inode until it
 * exits), then start the new file and leave. Any other Linux install has no
 * safe in-place path (it needs root), so the download page is opened instead.
 */
async function downloadAndApplyLinux(manifest, base, onProgress) {
  const entry = manifest.linux?.appImage;
  if (!entry?.url || !entry?.sha256) throw new Error('The server has no Linux build for that version.');
  const current = linuxAppImagePath();
  if (!current) {
    await shell.openExternal(`${base}/download`);
    return { status: 'manual', version: manifest.version, message: 'This copy of Voxara was installed from a package, so the new version is downloaded from the website and installed the same way.' };
  }
  const staging = path.join(app.getPath('userData'), 'updates');
  await fsp.mkdir(staging, { recursive: true });
  const packagePath = path.join(staging, entry.file);
  onProgress?.({ phase: 'downloading', percent: 0 });
  await download(`${base}${entry.url}`, packagePath, (percent) => onProgress?.({ phase: 'downloading', percent }));
  onProgress?.({ phase: 'verifying', percent: 100 });
  const actual = await sha256(packagePath);
  if (actual !== entry.sha256) {
    await fsp.unlink(packagePath).catch(() => {});
    throw new Error('The download did not match its checksum and was discarded.');
  }
  onProgress?.({ phase: 'restarting', percent: 100 });
  // Same directory as the current image so the final rename is atomic.
  const next = `${current}.new`;
  await fsp.copyFile(packagePath, next);
  await fsp.chmod(next, 0o755);
  await fsp.rename(next, current);
  await fsp.unlink(packagePath).catch(() => {});
  const child = spawn(current, [], { detached: true, stdio: 'ignore', env: { ...process.env } });
  child.unref();
  setTimeout(() => app.exit(0), 500);
  return { status: 'restarting', version: manifest.version };
}

/**
 * What this copy could switch to: the newest build, and the earlier builds the
 * server still offers, none of them below the security floor.
 */
async function listVersions(serverUrl) {
  const base = httpBase(serverUrl);
  const current = { version: app.getVersion(), serial: localSerial };
  if (!base || !app.isPackaged || (process.platform !== 'win32' && !linuxAppImagePath())) return { current, supported: false, history: [] };
  let manifest;
  try { manifest = await get(`${base}/update/latest.json`, { json: true }); } catch (err) { return { current, supported: true, error: err.message, history: [] }; }
  const floor = Number(manifest.minSerial) || 0;
  const entries = [manifest, ...(Array.isArray(manifest.history) ? manifest.history : [])]
    .filter((e) => e && Number(e.serial) > 0 && Number(e.serial) >= floor && Number(e.serial) !== localSerial)
    .map((e) => ({ version: e.version, serial: Number(e.serial), notes: e.notes || '', releasedAt: e.releasedAt || null, newer: Number(e.serial) > localSerial }));
  return { current, supported: true, minSerial: floor, newest: { version: manifest.version, serial: Number(manifest.serial) }, hold: holdStore.get(), history: entries };
}

/**
 * Switches to one of the builds the server offers (older or newer), verified
 * exactly like an update. Going back records a hold so the newer build is not
 * pushed straight back.
 */
async function rollbackTo(serverUrl, serial, onProgress) {
  const base = httpBase(serverUrl);
  if (!base) throw new Error('No server address configured.');
  if (!app.isPackaged || (process.platform !== 'win32' && !linuxAppImagePath())) throw new Error('Switching versions applies to the installed Windows app and the Linux AppImage only.');
  const manifest = await get(`${base}/update/latest.json`, { json: true });
  const wanted = Number(serial);
  const floor = Number(manifest.minSerial) || 0;
  const entry = [manifest, ...(Array.isArray(manifest.history) ? manifest.history : [])].find((e) => Number(e?.serial) === wanted);
  if (!entry) throw new Error('That version is no longer offered by the server.');
  if (wanted < floor) throw new Error('That version is older than the current security floor and cannot be used.');
  if (!entry.url || !entry.sha256) throw new Error('The server has no verified download for that version.');
  if (process.platform === 'linux' && !entry.linux?.appImage?.url) throw new Error('There is no Linux build of that version.');
  if (wanted < localSerial) holdStore.set({ serial: wanted, untilSerial: Number(manifest.serial) });
  else holdStore.set(null);
  cached = { manifest: entry, base };
  return downloadAndApply(onProgress);
}

/**
 * An install made by the installer can only be updated by the installer:
 * unzipping over the top leaves the Add/Remove Programs entry and the
 * shortcuts pointing at the old build. electron-builder leaves its uninstaller
 * beside the exe, so that is what we look for.
 */
function installedWithInstaller(installDir) {
  try {
    return fs.readdirSync(installDir).some((name) => /^Uninstall .*\.exe$/i.test(name));
  } catch {
    return false;
  }
}

/**
 * Downloads the pending update, verifies its hash, and stages the swap script.
 * Resolves once the app is about to restart.
 */
async function downloadAndApply(onProgress) {
  if (!cached) throw new Error('No update has been found yet.');
  const { manifest, base } = cached;
  if (process.platform === 'linux') return downloadAndApplyLinux(manifest, base, onProgress);

  const staging = path.join(app.getPath('userData'), 'updates');
  await fsp.mkdir(staging, { recursive: true });

  // process.execPath is <install>\Voxara.exe
  const exePath = process.execPath;
  const installDir = path.dirname(exePath);
  const useInstaller = Boolean(manifest.installer && manifest.installerUrl && manifest.installerSha256)
    && installedWithInstaller(installDir);

  const file = useInstaller ? manifest.installer : manifest.file;
  const href = useInstaller ? manifest.installerUrl : manifest.url;
  const expected = useInstaller ? manifest.installerSha256 : manifest.sha256;
  const packagePath = path.join(staging, file);

  onProgress?.({ phase: 'downloading', percent: 0 });
  await download(`${base}${href}`, packagePath, (percent) => {
    onProgress?.({ phase: 'downloading', percent });
  });

  onProgress?.({ phase: 'verifying', percent: 100 });
  const actual = await sha256(packagePath);
  if (actual !== expected) {
    await fsp.unlink(packagePath).catch(() => {});
    throw new Error('The download did not match its checksum and was discarded.');
  }

  onProgress?.({ phase: 'restarting', percent: 100 });

  // Leave a breadcrumb before handing over, so a failure here can be told
  // apart from a helper that ran and then went wrong.
  const log = path.join(staging, 'update.log');
  const note = (line) => { try { fs.appendFileSync(log, `${new Date().toISOString()}  ${line}\n`); } catch { /* best effort */ } };

  if (useInstaller) {
    // No helper script at all: the NSIS installer closes any running copy,
    // installs, and --force-run relaunches the app itself. Nothing here can be
    // blocked by a PowerShell policy, because PowerShell is never involved.
    note('running the installer directly with /S --force-run');
    const child = spawn(packagePath, ['/S', '--force-run'], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      let settled = false;
      child.once('spawn', () => { if (!settled) { settled = true; note('installer started'); resolve(); } });
      child.once('error', (err) => {
        if (settled) return;
        settled = true;
        note(`could not start the installer: ${err.message}`);
        reject(new Error(`Could not start the installer (${err.message}). Voxara has been left running and nothing was changed.`));
      });
      setTimeout(() => { if (!settled) { settled = true; resolve(); } }, 5000);
    });
    child.unref();
    // exit rather than quit: the app holds a single-instance lock, so a
    // process that lingers makes the relaunched copy quit on startup.
    setTimeout(() => app.exit(0), 500);
    return { status: 'restarting', version: manifest.version };
  }

  // Portable (zip) install: the swap needs a helper that runs after we exit.
  // cmd.exe rather than PowerShell — script execution policies and antivirus
  // rules routinely block powershell -File, and did for real installs.
  const scriptPath = path.join(staging, 'apply-update.cmd');
  await fsp.writeFile(scriptPath, applyScriptCmd(), 'utf8');

  // The script writes this the moment it starts running. If it never appears,
  // the helper was blocked — and quitting anyway would close the app with
  // nothing to bring it back.
  const marker = path.join(staging, 'apply.started');
  await fsp.rm(marker, { force: true }).catch(() => {});

  note('handing over to cmd.exe (mode=zip)');
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const cmdExe = path.join(systemRoot, 'System32', 'cmd.exe');
  const child = spawn(fs.existsSync(cmdExe) ? cmdExe : 'cmd.exe', ['/d', '/c', scriptPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      PULSE_UPD_PID: String(process.pid),
      PULSE_UPD_PACKAGE: packagePath,
      PULSE_UPD_STAGING: staging,
      PULSE_UPD_TARGET: installDir,
      PULSE_UPD_EXE: exePath,
    },
  });
  await new Promise((resolve, reject) => {
    let settled = false;
    child.once('spawn', () => { if (!settled) { settled = true; note('updater process started'); resolve(); } });
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      note(`could not start the updater: ${err.message}`);
      reject(new Error(`Could not start the updater process (${err.message}). Voxara has been left running.`));
    });
    setTimeout(() => { if (!settled) { settled = true; resolve(); } }, 5000);
  });
  child.unref();

  // Only exit once the script has proven it is actually running.
  const started = await new Promise((resolve) => {
    const startedAt = Date.now();
    const poll = setInterval(() => {
      if (fs.existsSync(marker)) { clearInterval(poll); resolve(true); }
      else if (Date.now() - startedAt > 8000) { clearInterval(poll); resolve(false); }
    }, 250);
  });
  if (!started) {
    note('updater script never reported in — keeping the app open');
    try { child.kill(); } catch { /* already gone */ }
    throw new Error('The update helper was blocked from running. Voxara has been left running and nothing was changed.');
  }
  note('updater script confirmed running');

  setTimeout(() => app.exit(0), 400);
  return { status: 'restarting', version: manifest.version };
}

/** The batch file that swaps a portable install after we exit. */
function applyScriptCmd() {
  // Everything arrives through PULSE_UPD_* environment variables, which keeps
  // batch argument quoting out of the picture entirely. tar.exe ships with
  // Windows 10 1803+ and extracts zips; robocopy merges instead of nesting.
  return [
    '@echo off',
    'setlocal EnableDelayedExpansion',
    // Proof of life: the app refuses to exit until this file exists.
    'echo ok>"%PULSE_UPD_STAGING%\\apply.started"',
    'set "LOG=%PULSE_UPD_STAGING%\\update.log"',
    'echo [cmd] updater started for pid %PULSE_UPD_PID%>>"%LOG%"',
    // Wait up to ~40s for the app to exit, then force it.
    'set /a TRIES=0',
    ':waitloop',
    'tasklist /FI "PID eq %PULSE_UPD_PID%" 2>nul | find "%PULSE_UPD_PID%" >nul',
    'if errorlevel 1 goto appgone',
    'set /a TRIES+=1',
    'if !TRIES! GEQ 40 (',
    '  echo [cmd] forcing pid %PULSE_UPD_PID% to close>>"%LOG%"',
    '  taskkill /F /PID %PULSE_UPD_PID% >nul 2>&1',
    '  goto appgone',
    ')',
    'ping -n 2 127.0.0.1 >nul',
    'goto waitloop',
    ':appgone',
    // Renderer/GPU processes share the exe name and can hold files open.
    'taskkill /F /IM Voxara.exe >nul 2>&1',
    'ping -n 2 127.0.0.1 >nul',
    'echo [cmd] extracting>>"%LOG%"',
    'rmdir /s /q "%PULSE_UPD_STAGING%\\staged" >nul 2>&1',
    'mkdir "%PULSE_UPD_STAGING%\\staged" >nul 2>&1',
    'tar -xf "%PULSE_UPD_PACKAGE%" -C "%PULSE_UPD_STAGING%\\staged" 2>>"%LOG%"',
    'if errorlevel 1 goto fail',
    'echo [cmd] copying>>"%LOG%"',
    'robocopy "%PULSE_UPD_STAGING%\\staged" "%PULSE_UPD_TARGET%" /E /IS /IT /R:3 /W:1 /NFL /NDL /NP /NJH /NJS >nul',
    'if %ERRORLEVEL% GEQ 8 goto fail',
    'rmdir /s /q "%PULSE_UPD_STAGING%\\staged" >nul 2>&1',
    'del /f /q "%PULSE_UPD_PACKAGE%" >nul 2>&1',
    'echo [cmd] done, relaunching>>"%LOG%"',
    'start "" "%PULSE_UPD_EXE%"',
    'exit /b 0',
    ':fail',
    'echo [cmd] FAILED with %ERRORLEVEL% — relaunching the old build>>"%LOG%"',
    'start "" "%PULSE_UPD_EXE%"',
    'exit /b 1',
    '',
  ].join('\r\n');
}

/** Startup check: offers the update through a native dialog. */
async function checkOnStartup(serverUrl, parentWindow) {
  const result = await checkForUpdates(serverUrl);
  if (result.status !== 'available') return result;

  const { response } = await dialog.showMessageBox(parentWindow, {
    type: 'info',
    buttons: ['Update and restart', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update available',
    message: `Voxara ${result.version} is available.`,
    detail: result.notes
      ? `${result.notes}\n\nYou are on ${app.getVersion()}.`
      : `You are on ${app.getVersion()}. The app will restart to finish.`,
  });

  if (response === 0) {
    try {
      // Without this the button appears to do nothing: the download is over a
      // hundred megabytes and the window just sits there until it finishes.
      await downloadAndApply((progress) => {
        if (parentWindow?.isDestroyed?.()) return;
        const fraction = progress.phase === 'downloading'
          ? Math.max(0.02, (progress.percent || 0) / 100)
          : 1;
        parentWindow?.setProgressBar?.(fraction);
        parentWindow?.webContents?.send('update:progress', progress);
      });
    } catch (err) {
      parentWindow?.setProgressBar?.(-1);
      parentWindow?.webContents?.send('update:progress', { phase: 'failed', message: err.message });
      dialog.showErrorBox('Update failed', err.message);
    }
  }
  return result;
}

/**
 * The rolling changelog the server publishes, for the "What's new" panel.
 * Unlike checkForUpdates this is not gated on being packaged — it just reads a
 * public feed. Returns { moreUrl, entries:[{version,date,notes}] }.
 */
async function fetchChangelog(serverUrl) {
  const base = httpBase(serverUrl);
  if (!base) return { moreUrl: '', entries: [] };
  try {
    const data = await get(`${base}/update/changelog.json`, { json: true });
    return {
      moreUrl: typeof data?.moreUrl === 'string' ? data.moreUrl : '',
      entries: Array.isArray(data?.entries) ? data.entries : [],
    };
  } catch {
    return { moreUrl: '', entries: [] };
  }
}

module.exports = {
  listVersions,
  rollbackTo,
  useHoldStore,
  usePinStore,
  checkForUpdates,
  downloadAndApply,
  checkOnStartup,
  fetchChangelog,
  isNewer,
  httpBase,
  openReleaseFolder: () => shell.openPath(path.join(app.getPath('userData'), 'updates')),
};
