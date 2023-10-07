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

function runPythonScript() {
  // Construir la ruta absoluta al script de Python
  const scriptPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'python-print', 'imprimir.py');

  // Ruta absoluta donde se encuentra la imagen
  const imagePath = path.join(process.resourcesPath, 'app.asar.unpacked', 'python-print', 'media', 'img', 'terronescolima-logo.png');


  // Listar los archivos en la carpeta 'python-print'
  fs.readdir(path.join(__dirname, 'python-print'), (err, files) => {
    if (err) {
      logger.error('Error listing files:', err);
    } else {
      logger.info('Files in python-print:', files);
    }
  });

  // Ejecutar el script de Python y pasar imagePath como argumento
  const pythonProcess = spawn("python", [scriptPath, imagePath]);

  pythonProcess.stdout.on("data", (data) => {
    console.log(`stdout: ${data}`);
    logger.info(`stdout: ${data}`);
  });

  pythonProcess.stderr.on("data", (data) => {
    console.error(`stderr: ${data}`);
    logger.error(`stderr: ${data}`);
    logger.info(`Current directory: ${process.cwd()}`);
  });

  pythonProcess.on("close", (code) => {
    console.log(`child process exited with code ${code}`);
    logger.info(`child process exited with code ${code}`);
  });
}



const fsPromises = fs.promises;
const configPath = './config.json';
let userDownloadPath = '';
var abierta = false;

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

// Save configuration
function saveConfig() {
  try {
    fs.writeFileSync(configPath, JSON.stringify({ downloadPath: userDownloadPath }));
    console.log(`Config saved: ${JSON.stringify({ downloadPath: userDownloadPath })}`);
  } catch (err) {
    console.error('Error saving configuration:', err);
  }
}

// Fetch image
// Variable para rastrear si una búsqueda está en curso
let isSearchInProgress = false;

async function fetchImage(searchQuery) {
  if (isSearchInProgress) {
    return 'Another search is in progress';
  }
  
  isSearchInProgress = true;

  try {
    // Establecer un tiempo límite para la búsqueda
    const timeout = new Promise((resolve, reject) => {
      setTimeout(() => reject('Search timed out'), 10000); // 10 segundos
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


ipcMain.on('select-download-path', async (event, arg) => {
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

// Perform search
ipcMain.on('perform-search', async (event, searchQuery) => {
  console.log(`Performing search for: ${searchQuery}`);
  try {
    await fetchImage(searchQuery);
    event.sender.send("download-success", "Image successfully downloaded.");
  } catch (error) {
    console.error('Error in perform-search:', error);
    event.sender.send("download-error", "Error downloading image.");
  }
});

// Load config at the beginning
loadConfig();
runPythonScript();


ipcMain.on('close-window', (event, arg) => {
  const win = BrowserWindow.getFocusedWindow();

  // Agregar un temporizador de 1 segundo (1000 milisegundos)
  setTimeout(() => {
    // Establecer abierta = false después del retraso
    abierta = false;
    
    // Cerrar la ventana
    win.close();
  }, 1000); // Cambia el valor (en milisegundos) según tus necesidades
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

      if (abierta) {
        logger.info("Cerrando ventana de búsqueda...");
        searchWin.close();
        abierta = false;
      } else if (!abierta) {
        logger.info("Abriendo ventana de búsqueda...");
        searchWin = new BrowserWindow({
          width: 800,
          height: 600,
          webPreferences: {
            nodeIntegration: true,
            contextIsolation: false, 
            sandbox: false, // Desactiva el modo sandbox
          },
        });



        searchWin
          .loadFile("./vistas/searchForm.html") 
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
  start(); 
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