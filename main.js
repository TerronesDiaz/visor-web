const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { autoUpdater } = require("electron-updater");
const packageConfig = require("./package.json");
const winston = require("winston");
const fs = require("fs");
const puppeteer = require("puppeteer");
const axios = require("axios");

const fsPromises = fs.promises;
const configPath = './config.json'; // Asegúrese de que esta ruta sea accesible

let userDownloadPath = ''; // Variable global para almacenar la ruta de descarga del usuario

// Función para cargar la configuración
function loadConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    userDownloadPath = config.downloadPath;
  } catch (err) {
    console.error('Error al cargar la configuración:', err);
    if (err.code === 'ENOENT') {
      userDownloadPath = app.getPath('downloads'); // Ruta de descargas predeterminada
      saveConfig(); // Guardar la configuración predeterminada
    }
  }
}

// Función para guardar la configuración
function saveConfig() {
  fs.writeFileSync(configPath, JSON.stringify({ downloadPath: userDownloadPath }));
}

// Cargar la configuración al inicio
loadConfig();

async function fetchImage(searchQuery) {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  await page.goto(`https://www.google.com/search?q=${searchQuery}&tbm=isch`);

  const imageUrl = await page.evaluate(() => {
    return document.querySelector(".rg_i").src;
  });

  await browser.close();

  // Descargar la imagen
  const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
  await fsPromises.writeFile(`${userDownloadPath}/${searchQuery}.jpg`, response.data, "binary");

  console.log(`Imagen guardada como ${userDownloadPath}/${searchQuery}.jpg`);
}


ipcMain.on('select-download-path', async (event, arg) => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });

  if (!result.canceled) {
    userDownloadPath = result.filePaths[0];
    saveConfig();
    event.sender.send("download-path-selected");
  }
});

ipcMain.on('set-download-path', (event, path) => {
  userDownloadPath = path;
  saveConfig();
});

ipcMain.on('perform-search', async (event, searchQuery) => {
  try {
    await fetchImage(searchQuery);
    event.sender.send("download-success");
  } catch (error) {
    event.sender.send("download-error");
  }
});



// Crea un directorio para los archivos de registro si no existe
const logDirectory = "./logs";
if (!fs.existsSync(logDirectory)) {
  fs.mkdirSync(logDirectory);
}

// Configuración de winston para registrar en un archivo
const logFileName = `${logDirectory}/app.log`;
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.File({ filename: logFileName })],
});

// Registrar en la consola durante el desarrollo
if (process.env.NODE_ENV !== "production") {
  logger.add(
    new winston.transports.Console({
      format: winston.format.simple(),
    })
  );
}

logger.info("Inicio del script.");

// Función para crear una nueva ventana
function createWindow(url) {
  logger.info("Creando nueva ventana.");

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
    },
    kiosk: true,
  });

  win.loadURL(url).then(() => {
    win.webContents.session
      .clearCache()
      .then(() => {
        logger.info("Caché eliminado exitosamente.");
      })
      .catch((err) => {
        logger.error("Error al eliminar el caché:", err);
      });
  });

  let searchWin = null; // Mantener una referencia a la ventana de búsqueda

  win.webContents.on("before-input-event", (event, input) => {
    logger.info("Evento de entrada detectado:", input.key);

    if (input.key === "F12") {
      logger.info("Tecla F12 presionada. Saliendo...");
      win.setKiosk(false);
      app.quit();
    }

    if (input.key === "F8") {
      logger.info("Tecla F8 presionada. Abriendo DevTools...");
      win.webContents.openDevTools();
    }

    if (input.key === "F7") {
      logger.info("Tecla F7 presionada.");

      if (searchWin && !searchWin.isDestroyed()) {
        logger.info("Cerrando ventana de búsqueda...");
        searchWin.close();
        searchWin = null;
      } else {
        logger.info("Abriendo ventana de búsqueda...");
        searchWin = new BrowserWindow({
          width: 400,
          height: 200,
          webPreferences: {
            nodeIntegration: true,
            contextIsolation: false, // No recomendado desde un punto de vista de seguridad
            sandbox: false, // Desactiva el modo sandbox
          },
        });

        // Abre DevTools automáticamente si es necesario
        searchWin.webContents.openDevTools();

        searchWin
          .loadFile("./vistas/searchForm.html") // Asegúrate de que esta ruta sea correcta
          .then(() => {
            logger.info("Archivo HTML cargado exitosamente.");
          })
          .catch((err) => {
            logger.error("Error al cargar el archivo HTML:", err);
          });
      }
    }

    // Escucha el evento IPC para realizar la búsqueda
    ipcMain.on("perform-search", async (event, searchQuery) => {
      // Aquí puedes colocar la función para hacer el fetch y descargar la imagen
      await fetchImage(searchQuery);
    });
  });
}

app.whenReady().then(async () => {
  logger.info("Aplicación lista. Inicializando autoUpdater.");

  autoUpdater.autoDownload = true; // Activa la descarga automática de actualizaciones
  autoUpdater.checkForUpdatesAndNotify();

  autoUpdater.on("checking-for-update", () => {
    logger.info("Buscando actualizaciones pendientes...");
  });

  autoUpdater.on("update-available", (info) => {
    logger.info("Actualización disponible:", info);
  });

  autoUpdater.on("update-not-available", (info) => {
    logger.info("No hay ninguna actualizaciones disponible actualmente:", info);
  });

  autoUpdater.on("update-downloaded", (info) => {
    logger.info("Actualización descargada:", info);
    const win = BrowserWindow.getFocusedWindow();
    if (win) {
      win.webContents.session.clearCache().then(() => {
        dialog
          .showMessageBox({
            title: "Actualización descargada",
            message: `Se ha descargado una nueva actualización. La versión actual es ${info.version}. La aplicación se reiniciará para aplicar los cambios.`,
          })
          .then(() => {
            autoUpdater.quitAndInstall();
          });
      });
    }
  });

  autoUpdater.on("error", (error) => {
    logger.error("Error durante la actualización:", error);
  });

  const urls = packageConfig.appURLs;
  let selectedURL;

  if (urls && urls.length > 1) {
    const options = {
      type: "question",
      buttons: urls,
      title: "Seleccione una URL",
      message: "¿A cuál de sus tiendas desea acceder?",
    };

    const userChoice = await dialog.showMessageBox(options);
    selectedURL = urls[userChoice.response];
  } else {
    selectedURL = urls ? urls[0] : packageConfig.appURL;
  }

  createWindow(selectedURL);
});

app.on("window-all-closed", () => {
  logger.info("Todas las ventanas están cerradas. Saliendo...");
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  logger.info("Aplicación activada.");
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow(packageConfig.appURL);
  }
});



logger.info("Fin del script.");
