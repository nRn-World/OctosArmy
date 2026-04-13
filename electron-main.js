import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import updaterPkg from 'electron-updater';
const { autoUpdater } = updaterPkg;
import log from 'electron-log';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

log.transports.file.level = 'info';
autoUpdater.logger = log;

app.setAppUserModelId('com.nRnWorld.octosarmy');

const isPackaged = app.isPackaged;

if (isPackaged) {
  process.env.NODE_ENV = 'production';
  process.env.DIST_PATH = path.join(process.resourcesPath, 'dist');
  
  // Load .env from resources if it exists
  const envPath = path.join(process.resourcesPath, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    envContent.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const [key, ...vals] = trimmed.split('=');
      if (key && vals.length > 0) {
        process.env[key.trim()] = vals.join('=').trim();
      }
    });
    log.info('Laddade .env från: ' + envPath);
  }
}

// Fallback defaults for Ollama
if (!process.env.OLLAMA_BASE_URL) process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
if (!process.env.OLLAMA_MODEL) process.env.OLLAMA_MODEL = 'gemma4:e4b';

// State management in main process
const appDataDir = path.join(os.homedir(), 'AppData', 'Roaming', 'OctosArmy');
if (!fs.existsSync(appDataDir)) fs.mkdirSync(appDataDir, { recursive: true });

const configDir = path.join(appDataDir, 'config');
if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
const rootsFile = path.join(configDir, 'roots.json');

let activeWorkspaceRoots = [path.join(appDataDir, 'workspace')];
if (fs.existsSync(rootsFile)) {
  try {
    activeWorkspaceRoots = JSON.parse(fs.readFileSync(rootsFile, 'utf-8'));
  } catch(e) { log.error('Kunde inte ladda roots.json'); }
}

if (!fs.existsSync(activeWorkspaceRoots[0])) fs.mkdirSync(activeWorkspaceRoots[0], { recursive: true });

let mainWindow;

// --- IPC HANDLERS ---

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
  activeWorkspaceRoots = Array.from(new Set(roots.map(r => {
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
      ? path.join(process.resourcesPath, 'server.js')
      : path.join(__dirname, 'dist', 'server.js');

    log.info('Startar backend-server: ' + serverPath);
    
    // Server is bundled as CJS, so we need require() not import()
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    require(serverPath);
    
    log.info('Backend-server startad på port 3000');
    return true;
  } catch (err) {
    log.error('SERVERFEL: ' + err.message);
    log.error(err.stack);
    return false;
  }
}

function createWindow() {
  const preloadPath = isPackaged
    ? path.join(process.resourcesPath, 'preload.js')
    : path.join(__dirname, 'preload.js');

  log.info('Preload: ' + preloadPath);

  mainWindow = new BrowserWindow({
    width: 1300,
    height: 900,
    backgroundColor: '#0A0A0B',
    title: 'OctosArmy - Multi-Agent Control System',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath,
      webSecurity: false,
    },
  });

  const distPath = isPackaged
    ? path.join(process.resourcesPath, 'dist')
    : path.join(__dirname, 'dist');

  const indexPath = path.join(distPath, 'index.html');

  // Start backend server FIRST, then load UI
  startBackend().then((ok) => {
    if (ok) {
      log.info('Server OK – laddar UI: ' + indexPath);
    } else {
      log.warn('Server MISSLYCKADES – laddar UI ändå (IPC fungerar fortfarande)');
    }
    mainWindow.loadFile(indexPath).catch(err => {
      log.error('LADDNINGSFEL: ' + err.message);
    });
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
