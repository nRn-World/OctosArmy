import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Konfigurera loggning för felsökning bakom kulisserna
log.transports.file.level = "info";
autoUpdater.logger = log;

// Ställ in AppUserModelId för att inte bråka med Windows Brandvägg
app.setAppUserModelId("com.nRnWorld.octosarmy");

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 600,
    autoHideMenuBar: true,
    title: "OctosArmy - Multi-Agent Control System",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Starta Express-servern internt (som vi byggt med esbuild)
  import('./dist/server.js').then(() => {
    // Ge servern 1 sekund att vakna, ladda sedan gränssnittet
    setTimeout(() => {
      mainWindow.loadURL('http://localhost:3000');
    }, 1000);
  }).catch(err => {
    log.error("Server start misslyckades: ", err);
  });

  // Kolla efter nya uppdateringar direkt när fönstret öppnas
  autoUpdater.checkForUpdatesAndNotify();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// -- UPPDATERINGSLOGIK BÖRJAR HÄR -- //
autoUpdater.on('update-available', () => {
  log.info("Ny uppdatering hittad! Laddar ner i bakgrunden...");
});

autoUpdater.on('update-downloaded', (info) => {
  log.info("Uppdatering nedladdad. Installerar tyst och startar om appen.");
  // isSilent = true, isForceRunAfter = true
  autoUpdater.quitAndInstall(true, true);
});
