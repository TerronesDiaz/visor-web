const { app, BrowserWindow, dialog } = require("electron");
const { autoUpdater } = require("electron-updater");
const packageConfig = require('./package.json');

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

app.whenReady().then(async () => {
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
  const urls = packageConfig.appURLs;
  let selectedURL;

  if (urls && urls.length > 1) {
    const options = {
      type: 'question',
      buttons: urls,
      title: 'Seleccione una URL',
      message: '¿A cuál URL desea acceder?'
    };

    const userChoice = await dialog.showMessageBox(options);
    selectedURL = urls[userChoice.response];
  } else {
    selectedURL = urls ? urls[0] : packageConfig.appURL;
  }

  createWindow(selectedURL);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow(packageConfig.appURL);
  }
});





//electron-packager . TERRONES --platform=win32 --arch=x64 --out=./ --overwrite