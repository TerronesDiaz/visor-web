const { app, BrowserWindow } = require("electron");
const { autoUpdater } = require("electron-updater");
require('./apiCajon/index.js');

// Define los enlaces correspondientes a cada ejecutable
const ejecutables = {
  "TERRONES": "https://terronescolima.com/",
  "TUNKITOS": "https://tunkitos.terronescolima.com/"
};

// Función para crear la ventana con el enlace correspondiente
function createWindow(ejecutable) {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
    },
    kiosk: true,
  });

  win.loadURL(ejecutables[ejecutable]);

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
  // Aquí puedes especificar qué ejecutable se va a utilizar (por ejemplo, "TERRONES" o "TUNKITOS").
  const ejecutable = "TERRONES";

  createWindow(ejecutable);

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
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    // De nuevo, especifica el ejecutable a utilizar aquí.
    const ejecutable = "TERRONES";
    createWindow(ejecutable);
  }
});

//electron-packager . MiAplicacion --platform=win32 --arch=x64 --out=./ --overwrite