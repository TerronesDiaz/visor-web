const { app, BrowserWindow } = require("electron");
const { autoUpdater } = require("electron-updater");
require('./apiCajon/index.js');

function createWindow(url) {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
    },
    kiosk: true,
  });

  win.loadURL(url);

  // Escuchar eventos de teclado en la ventana
  win.webContents.on("before-input-event", (event, input) => {
    if (input.key === "F12") {
      win.setKiosk(false);
      app.quit();
    }

    if (input.key === "F8") {
      win.webContents.openDevTools();
    }
  });
}

app.whenReady().then(() => {
  // Configuración de autoUpdater para las actualizaciones automáticas
  autoUpdater.checkForUpdatesAndNotify();

  autoUpdater.on('update-downloaded', () => {
    // Limpia solo el caché.
    const win = BrowserWindow.getFocusedWindow();
    if (win) {
      win.webContents.session.clearCache().then(() => {
        // Reinicia la aplicación para aplicar la actualización.
        autoUpdater.quitAndInstall();
      });
    }
  });

  // Selecciona la URL correcta según la configuración en package.json
  const packageConfig = require('./package.json');
  createWindow(packageConfig.appURL);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});





//electron-packager . TERRONES --platform=win32 --arch=x64 --out=./ --overwrite