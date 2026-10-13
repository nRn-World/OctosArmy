import { app, BrowserWindow, dialog, ipcMain, Tray, Menu, shell } from 'electron';
import updaterPkg from 'electron-updater';
const { autoUpdater } = updaterPkg;
import log from 'electron-log';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

log.transports.file.level = 'info';
autoUpdater.logger = log;

app.setAppUserModelId('com.nRnWorld.octosarmy');

const isPackaged = app.isPackaged;

// State management in main process
const appDataDir = path.join(os.homedir(), 'AppData', 'Roaming', 'OctosArmy');
if (!fs.existsSync(appDataDir)) fs.mkdirSync(appDataDir, { recursive: true });

if (isPackaged) {
  process.env.NODE_ENV = 'production';
  process.env.DIST_PATH = path.join(process.resourcesPath, 'dist');
  const envPath = path.join(appDataDir, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const allowed = new Set([
        'OLLAMA_BASE_URL',
        'OLLAMA_MODEL',
        'OCTOSARMY_MAX_STEPS',
        'OCTOSARMY_TERMINAL_TIMEOUT',
        'OCTOSARMY_MAX_TERMINAL_OUTPUT',
      ]);
      const envContent = fs.readFileSync(envPath, 'utf-8');
      envContent.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const [key, ...vals] = trimmed.split('=');
        const k = (key || '').trim();
        if (!k || !allowed.has(k) || vals.length === 0) return;
        process.env[k] = vals.join('=').trim();
      });
      log.info('Laddade lokala runtime-variabler från: ' + envPath);
    } catch (e) {
      log.warn('Kunde inte läsa lokal .env i AppData. Fortsätter med defaults.');
    }
  }
}

// Fallback defaults for Ollama
if (!process.env.OLLAMA_BASE_URL) process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
if (!process.env.OLLAMA_MODEL) process.env.OLLAMA_MODEL = 'gemma4:e4b';

// The backend and this process must agree on the port: the UI is served by the backend.
const BACKEND_PORT = Number(process.env.OCTOS_PORT || 3000);
process.env.OCTOS_PORT = String(BACKEND_PORT);
const BACKEND_ORIGIN = `http://127.0.0.1:${BACKEND_PORT}`;

try {
  const baseDir = isPackaged ? appDataDir : path.join(os.tmpdir(), 'OctosArmy-dev');
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  const cacheDir = path.join(baseDir, 'cache');
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  app.setPath('userData', baseDir);
  app.setPath('cache', cacheDir);
  app.commandLine.appendSwitch('disk-cache-dir', cacheDir);
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
} catch (e) {}

const configDir = path.join(appDataDir, 'config');
if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
const rootsFile = path.join(configDir, 'roots.json');

let activeWorkspaceRoots = [path.join(appDataDir, 'workspace')];
if (fs.existsSync(rootsFile)) {
  try {
    const saved = JSON.parse(fs.readFileSync(rootsFile, 'utf-8'));
    if (Array.isArray(saved) && saved.length > 0 && saved[0]) {
      activeWorkspaceRoots = saved;
    }
  } catch(e) { log.error('Kunde inte ladda roots.json'); }
}

// Skapa mappen om den inte finns (och se till att vi faktiskt har en path)
const primaryRoot = activeWorkspaceRoots[0] || path.join(appDataDir, 'workspace');
if (!fs.existsSync(primaryRoot)) fs.mkdirSync(primaryRoot, { recursive: true });

let mainWindow;
let tray = null;
let isQuitting = false;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// --- IPC HANDLERS ---

ipcMain.on('restart-and-install', () => {
  isQuitting = true;
  autoUpdater.quitAndInstall();
});

ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Välj en mapp för OctosArmy',
    buttonLabel: 'Välj mapp'
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('get-roots', () => activeWorkspaceRoots);

ipcMain.handle('set-roots', (event, roots) => {
  if (!Array.isArray(roots)) return activeWorkspaceRoots;
  activeWorkspaceRoots = Array.from(new Set(roots
    .filter((r) => typeof r === 'string' && r.trim().length > 0)
    .slice(0, 10)
    .map(r => {
      const cleaned = r.trim().replace(/[\\/]+$/, "");
      return path.resolve(cleaned);
    })));
  activeWorkspaceRoots.forEach(r => {
    if (!fs.existsSync(r)) {
      try { fs.mkdirSync(r, { recursive: true }); } catch(e) {}
    }
  });
  fs.writeFileSync(rootsFile, JSON.stringify(activeWorkspaceRoots));
  return activeWorkspaceRoots;
});

ipcMain.handle('get-workspace', () => {
  return activeWorkspaceRoots.map(root => {
    const resolved = path.resolve(root);
    const files = fs.existsSync(resolved) ? fs.readdirSync(resolved, { recursive: true }) : [];
    return { root: resolved, files: files.filter(f => typeof f === 'string') };
  });
});

// --- SERVER STARTUP (needed for pipeline, logs, ollama) ---

async function startBackend() {
  try {
    const serverPath = isPackaged
      ? path.join(process.resourcesPath, 'server.cjs')
      : path.join(__dirname, 'dist', 'server.cjs');

    log.info('Startar backend-server: ' + serverPath);

    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    require(serverPath);

    log.info('Backend-server startad på port ' + BACKEND_PORT);
    return true;
  } catch (err) {
    log.error('SERVERFEL: ' + err.message);
    log.error(err.stack);
    return false;
  }
}

/** Wait until the backend actually answers, instead of guessing that it is up. */
async function waitForBackend(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BACKEND_ORIGIN + '/api/health');
      if (res.ok) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

/**
 * electron-updater only verifies an update's Authenticode signature when the build
 * declares a publisherName. Without one it installs whatever it downloaded, so say so
 * loudly instead of pretending the update channel is verified.
 */
function checkUpdateSignaturePolicy() {
  try {
    const ymlPath = path.join(process.resourcesPath, 'app-update.yml');
    if (!fs.existsSync(ymlPath)) return;
    const yml = fs.readFileSync(ymlPath, 'utf-8');
    if (/^\s*publisherName\s*:/m.test(yml)) return;
    log.warn(
      'SECURITY: updates are installed without code-signature verification because this build has no ' +
        'publisherName configured. Sign the build and set build.win.publisherName to close this gap.'
    );
  } catch (e) {
    log.warn('Kunde inte granska app-update.yml: ' + e.message);
  }
}

function createWindow() {
  const preloadPath = isPackaged
    ? path.join(process.resourcesPath, 'preload.js')
    : path.join(__dirname, 'preload.js');

  log.info('Preload: ' + preloadPath);

  const iconPath = path.join(__dirname, 'Logo', 'OSAI-no-bg.ico');

  mainWindow = new BrowserWindow({
    width: 1300,
    height: 900,
    backgroundColor: '#0A0A0B',
    title: 'OctosArmy - Multi-Agent Control System',
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath,
      sandbox: true,
      // The UI is served by the local backend over http://127.0.0.1, so the browser's
      // normal security model (same-origin policy, CORS) stays enabled.
      webSecurity: true,
    },
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  // Foreign links open in the real browser; the app window never navigates away.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(BACKEND_ORIGIN)) return { action: 'allow' };
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(BACKEND_ORIGIN)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  // Start backend server FIRST, wait for it to actually answer, then load the UI from it.
  startBackend().then(async (ok) => {
    if (!ok) {
      dialog.showErrorBox(
        'OctosArmy – backend kunde inte startas',
        'Den lokala servern startade inte. Stäng andra program på port ' +
          BACKEND_PORT +
          ' och starta OctosArmy igen. Se loggen för detaljer.'
      );
    }
    const ready = await waitForBackend();
    if (!ready) {
      log.error('Backend svarade inte inom tidsgränsen.');
      dialog.showErrorBox(
        'OctosArmy – backend svarar inte',
        'Ingen kontakt med http://127.0.0.1:' + BACKEND_PORT + '. Kontrollera loggen.'
      );
    }
    log.info('Laddar UI från ' + BACKEND_ORIGIN);
    mainWindow.loadURL(BACKEND_ORIGIN + '/').catch((err) => {
      log.error('LADDNINGSFEL: ' + err.message);
    });
  });
}

app.whenReady().then(() => {
  createWindow();

  if (isPackaged) {
    autoUpdater.logger = log;
    autoUpdater.allowDowngrade = false;
    checkUpdateSignaturePolicy();
    autoUpdater.checkForUpdatesAndNotify();

    autoUpdater.on('checking-for-update', () => {
      log.info('Kontrollerar efter uppdateringar...');
    });

    autoUpdater.on('update-available', (info) => {
      log.info('Uppdatering tillgänglig: ' + info.version);
      mainWindow?.webContents.send('update-available', info);
    });

    autoUpdater.on('update-not-available', (info) => {
      log.info('Ingen uppdatering. Nuvarande version: ' + info.version);
    });

    autoUpdater.on('update-downloaded', (info) => {
      log.info('Uppdatering nedladdad: ' + info.version);
      mainWindow?.webContents.send('update-downloaded', info);
    });

    autoUpdater.on('error', (err) => {
      log.error('Auto-updater fel: ' + err.message);
      mainWindow?.webContents.send('update-error', err.message);
    });
  }

  const iconPath = path.join(__dirname, 'Logo', 'OSAI-no-bg.ico');
  tray = new Tray(iconPath);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Visa OctosArmy', click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { label: 'Avsluta', click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('OctosArmy - Körs i bakgrunden');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Gör ingenting istället för att stänga av appen, låt tray vara kvar.
  }
});
