const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { autoUpdater } = require("electron-updater");
const packageConfig = require("./package.json");
const winston = require("winston");
const fs = require("fs");
const puppeteer = require("puppeteer");
const axios = require("axios");
const { spawn } = require("child_process");
const path = require('path');
const { start } = require('./apiCajon/index');
const { log } = require("console");

// Lee las URLs desde appURLs.json
function loadURLs() {
  try {
    const urls = JSON.parse(fs.readFileSync(path.join(__dirname, 'appURLs.json'))).appURLs;
    return urls;
  } catch (err) {
    console.error('Error al cargar URLs:', err);
    return []; // Devuelve un array vacío si hay un error
  }
}

function runPythonScript(imagePath) {
  const imageToUse = imagePath || path.join(__dirname, 'python-print', 'media', 'img', 'picture.png');
  executePythonScript(imageToUse);
}

function executePythonScript(imagePath) {
  // Determina la ruta del script de Python según el entorno
  const scriptPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'python-print', 'imprimir.py')
    : path.join(__dirname, 'python-print', 'imprimir.py');

  const pythonProcess = spawn("python", [scriptPath, imagePath]);

  pythonProcess.stdout.on("data", (data) => {
    console.log(`stdout: ${data}`);
    logger.info(`stdout: ${data}`);
  });

  pythonProcess.stderr.on("data", (data) => {
    console.error(`stderr: ${data}`);
    logger.error(`stderr: ${data}`);
  });

  pythonProcess.on("close", (code) => {
    console.log(`child process exited with code ${code}`);
    logger.info(`child process exited with code ${code}`);
    if (code !== 0) {
      logger.error(`El script de Python terminó con un error con el código: ${code}`);
    }
  });

  pythonProcess.on("error", (error) => {
    console.error(`Error al ejecutar el script de Python: ${error}`);
    logger.error(`Error al ejecutar el script de Python: ${error}`);
  });
}

function checkAndSelectImage(selectedURL) {
  const storeName = selectedURL.replace(/^https?:\/\//, '').replace(/\.[a-z]{2,}\/?$/, '');
  const userDataPath = app.getPath('userData');
  const defaultImagePath = path.join(userDataPath, 'images', `${storeName}.png`);

  return new Promise((resolve) => {
    // Verificar permisos de lectura del archivo antes de acceder a él
    fs.access(defaultImagePath, fs.constants.R_OK, (accessErr) => {
      if (accessErr) {
        if (accessErr.code === 'EPERM' || accessErr.code === 'EACCES') {
          console.error("Error de permisos al acceder a la imagen:", accessErr);
          logger.error("Error de permisos al acceder a la imagen:", accessErr);
        } else {
          console.error("Error al acceder a la imagen (no existe):", accessErr);
          logger.error("Error al acceder a la imagen (no existe):", accessErr);
        }
        resolve(false);
      } else {
        // Si tiene permisos de lectura, verificar si la imagen es válida
        fs.readFile(defaultImagePath, (readErr, data) => {
          if (readErr) {
            console.error("Error al leer la imagen:", readErr);
            logger.error("Error al leer la imagen:", readErr);
            resolve(false);
          } else if (!isValidImage(data)) {
            logger.error("La imagen está perdida o corrupta.");
            console.error("La imagen está perdida o corrupta.");
            resolve(false);
          } else {
            logger.info("Imagen encontrada y válida:", defaultImagePath);
            resolve(defaultImagePath);
          }
        });
      }
    });
  });
}

// Función para verificar si los datos corresponden a una imagen válida
function isValidImage(data) {
  if (!data || data.length < 4) {
    return false; // Archivo demasiado pequeño para ser una imagen válida
  }

  const signatures = {
    jpg: [0xff, 0xd8, 0xff],
    png: [0x89, 0x50, 0x4e, 0x47],
    gif: [0x47, 0x49, 0x46, 0x38],
    bmp: [0x42, 0x4d],
    webp: [0x52, 0x49, 0x46, 0x46],
  };

  const fileHeader = data.slice(0, 4);

  for (const signature of Object.values(signatures)) {
    if (signature.every((byte, index) => byte === fileHeader[index])) {
      return true;
    }
  }

  return false;
}



const fsPromises = fs.promises;
const configPath = './config.json';
let userDownloadPath = '';
let abierta = false;

// Load configuration at the start
function loadConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    userDownloadPath = config.downloadPath;
    console.log(`Config loaded: ${JSON.stringify(config)}`);
  } catch (err) {
    console.error('Error loading configuration:', err);
    if (err.code === 'ENOENT') {
      userDownloadPath = app.getPath('downloads');
      saveConfig();
    }
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(configPath, JSON.stringify({ downloadPath: userDownloadPath }));
    console.log(`Config saved: ${JSON.stringify({ downloadPath: userDownloadPath })}`);
  } catch (err) {
    console.error('Error saving configuration:', err);
  }
}

let isSearchInProgress = false;

async function fetchImage(searchQuery) {
  if (isSearchInProgress) {
    return 'Another search is in progress';
  }

  isSearchInProgress = true;

  try {
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject('Search timed out'), 10000);
    });

    const search = (async () => {
      const browser = await puppeteer.launch({ headless: "new" });
      const page = await browser.newPage();
      await page.goto(`https://www.google.com/search?q=${searchQuery}&tbm=isch`);

      const imageUrl = await page.evaluate(() => {
        return document.querySelector(".rg_i")?.src || null;
      });

      await browser.close();

      if (!imageUrl) {
        return 'Image URL not found';
      }

      const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
      const savePath = `${userDownloadPath}/${searchQuery}.jpg`;
      await fsPromises.writeFile(savePath, response.data, "binary");

      return `Image saved at ${savePath}`;
    })();

    const result = await Promise.race([timeout, search]);
    return result;

  } catch (error) {
    console.error('Error in fetchImage:', error);
    return `Error in fetchImage: ${error.message}`;
  } finally {
    isSearchInProgress = false;
  }
}

ipcMain.on('select-download-path', async (event) => {
  try {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });

    if (!result.canceled) {
      userDownloadPath = result.filePaths[0];
      saveConfig();
      event.sender.send("download-path-selected", userDownloadPath);
      console.log(`Download path set to: ${userDownloadPath}`);
    }
  } catch (error) {
    console.error('Error in select-download-path:', error);
  }
});

ipcMain.on('set-download-path', (event, path) => {
  try {
    userDownloadPath = path;
    saveConfig();
    event.sender.send("download-path-set", userDownloadPath);
    console.log(`Download path manually set to: ${userDownloadPath}`);
  } catch (error) {
    console.error('Error in set-download-path:', error);
  }
});

ipcMain.on('perform-search', async (event, searchQuery) => {
  console.log(`Performing search for: ${searchQuery}`);
  try {
    const message = await fetchImage(searchQuery);
    event.sender.send("download-success", message);
  } catch (error) {
    console.error('Error in perform-search:', error);
    event.sender.send("download-error", "Error downloading image.");
  }
});

loadConfig();

ipcMain.on('close-window', (event) => {
  const win = BrowserWindow.getFocusedWindow();
  setTimeout(() => {
    abierta = false;
    win.close();
  }, 1000);
});

const logDirectory = "./logs";
if (!fs.existsSync(logDirectory)) {
  fs.mkdirSync(logDirectory);
}

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

if (process.env.NODE_ENV !== "production") {
  logger.add(
    new winston.transports.Console({
      format: winston.format.simple(),
    })
  );
}

logger.info("Inicio del script.");

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


  logger.info("Ventana de navegador creada con configuración inicial.");

  win.loadURL(url)
    .then(() => {
        logger.info(`URL cargada exitosamente: ${url}`);
        return win.webContents.session.clearCache();
    })
    .then(() => {
        logger.info("Caché eliminado exitosamente.");
    })
    .catch((error) => {
        logger.error(`Error al cargar la URL ${url} o al eliminar caché:`, error);
        app.quit();
    });

  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
      logger.error(`Error ${errorCode} cargando ${validatedURL}: ${errorDescription}`);
      app.quit();
  });

  win.webContents.on("before-input-event", (event, input) => {

      if (input.key === "F12") {
          logger.info("Tecla F12 presionada. Saliendo del modo kiosco y cerrando la aplicación...");
          win.setKiosk(false);
          app.quit();
      }

      if (input.key === "F8") {
          logger.info("Tecla F8 presionada. Abriendo DevTools...");
          win.webContents.openDevTools();
          logger.info("DevTools abierto.");
      }

      if (input.key === "F7") {
          logger.info("Tecla F7 presionada. Alternando ventana de búsqueda.");
          if (abierta) {
              logger.info("Ventana de búsqueda ya está abierta. Procediendo a cerrar...");
              searchWin.close();
              abierta = false;
              logger.info("Ventana de búsqueda cerrada.");
          } else {
              logger.info("Ventana de búsqueda no está abierta. Procediendo a abrir...");
              searchWin = new BrowserWindow({
                  width: 800,
                  height: 600,
                  webPreferences: {
                      nodeIntegration: true,
                      contextIsolation: false,
                      sandbox: false,
                      webSecurity: false,
                  },
              });

              logger.info("Nueva ventana de búsqueda creada.");

              searchWin.loadFile("./vistas/searchForm.html")
                .then(() => {
                    logger.info("Archivo HTML para búsqueda cargado exitosamente.");
                })
                .catch((err) => {
                    logger.error("Error al cargar el archivo HTML de búsqueda:", err);
                });
          }
      }
  });

  logger.info("Configuración de eventos de la ventana completada.");
}


function createURLSelectorWindow(urls) {
  const urlSelectorWindow = new BrowserWindow({
    width: 800,
    height: 800,
    webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        webSecurity: false,
    },
  });

  urlSelectorWindow.loadFile(path.join(__dirname, 'vistas', 'urlSelector.html'));

  urlSelectorWindow.webContents.on('did-finish-load', () => {
    urlSelectorWindow.webContents.send('load-urls', urls);
  });

  return urlSelectorWindow;
}

function createImageSelectionWindow(selectedURL) {
  const storeName = selectedURL.replace(/^https?:\/\//, '').replace(/\.[a-z]{2,}\/?$/, '');
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 800,
      height: 600,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
      resizable: false,
      closable: true,
    });

    let imageSelected = false;

    win.loadFile(path.join(__dirname, 'vistas', 'image-selection.html'));

    ipcMain.once('image-selected', (event, imagePath) => {
      imageSelected = true;
      win.close();

      const userDataPath = app.getPath('userData');
      const imageDirPath = path.join(userDataPath, 'images');
      if (!fs.existsSync(imageDirPath)) {
        fs.mkdirSync(imageDirPath, { recursive: true });
      }
      const savedImagePath = path.join(imageDirPath, `${storeName}.png`);
      const imageBuffer = fs.readFileSync(imagePath);
      fs.writeFileSync(savedImagePath, imageBuffer);

      resolve(savedImagePath);
    });

    win.on('closed', () => {
      if (!imageSelected) {
        resolve(null);
      }
    });
  });
}

app.whenReady().then(async () => {
  start();
  logger.info("Aplicación lista. Inicializando autoUpdater.");
  autoUpdater.autoDownload = true;
  autoUpdater.checkForUpdatesAndNotify();

  autoUpdater.on("checking-for-update", () => {
    logger.info("Buscando actualizaciones pendientes...");
  });

  autoUpdater.on("update-available", (info) => {
    logger.info("Actualización disponible:", info);
  });

  autoUpdater.on("update-not-available", (info) => {
    logger.info("No hay ninguna actualización disponible actualmente:", info);
  });

  autoUpdater.on("update-downloaded", (info) => {
    logger.info("Actualización descargada:", info);
    const win = BrowserWindow.getFocusedWindow();
    if (win) {
      win.webContents.session.clearCache().then(() => {
        dialog.showMessageBox({
          title: "Actualización descargada",
          message: `Se ha descargado una nueva actualización. La versión actual es ${info.version}. La aplicación se reiniciará para aplicar los cambios.`,
        }).then(() => {
          autoUpdater.quitAndInstall();
        });
      });
    }
  });

  autoUpdater.on("error", (error) => {
    logger.error("Error durante la actualización:", error);
  });

  const urls = loadURLs();
  var selectedURL;

  if (urls && urls.length > 0) {
    if (urls.length > 1) {
      const urlSelectorWindow = createURLSelectorWindow();
  
      // Enviar las URLs al proceso de renderizado cuando la ventana haya terminado de cargar
      urlSelectorWindow.webContents.on('did-finish-load', () => {
        urlSelectorWindow.webContents.send('load-urls', urls);
      });
  
      selectedURL = await new Promise((resolve) => {
        ipcMain.once('url-selected', (event, url) => {
          resolve(url);
          console.log("URL seleccionada:", url);
          //Cerrar después de 2 segundos
          setTimeout(() => {
            urlSelectorWindow.close();
          }, 500);
        });
  
        urlSelectorWindow.on('closed', () => {
          if (!selectedURL) {
            console.log("No se seleccionó ninguna URL. Cerrando aplicación.");
            resolve(null);
            app.quit();
          }
        });
      });
  
      if (!selectedURL) return;
  
    } else {
      selectedURL = urls[0];
    }
  } else {
    console.log("No hay URLs disponibles. Cerrando aplicación.");
    app.quit();
    return;
  }

  try {
    const defaultImagePath = await checkAndSelectImage(selectedURL);
    logger.info("Imagen predeterminada seleccionada:", defaultImagePath);
    let imagePath;
    if (!defaultImagePath) {
      logger.info("No se encontró ninguna imagen predeterminada.");
      imagePath = await createImageSelectionWindow(selectedURL);
      logger.info("Imagen seleccionada:", imagePath);
    } else {
      imagePath = defaultImagePath;
      logger.info("Imagen predeterminada seleccionada!:", imagePath);
    }

    if (imagePath) {
      logger.info("Imagen seleccionada!:", imagePath);
      runPythonScript(imagePath);
      createWindow(selectedURL);
    } else {
      logger.error("No se seleccionó ninguna imagen!!.");
      runPythonScript(imagePath);
      createWindow(selectedURL);
    }
  } catch (error) {
    logger.error("Error en la selección de imagen:", error);
    imagePath = await createImageSelectionWindow(selectedURL);
    logger.info("Imagen seleccionada after error:", imagePath);
    runPythonScript(imagePath);
    createWindow(selectedURL);
  }
});


app.on("activate", () => {
  logger.info("Aplicación activada.");
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow(packageConfig.appURL);
  }
});

logger.info("Fin del script.");

// Manejar globalmente las promesas no gestionadas
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
