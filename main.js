const { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const winston = require("winston");
const fs = require("fs");
const { spawn } = require("child_process");
const http = require("http");
const path = require('path');
const localRuntime = require('./local-runtime');

let printProcess = null;
let startupWindow = null;
let bootPromise = null;
let currentRuntimeStatus = { state: 'starting', phase: 'bootstrap', message: 'Preparando POS local…' };

function runPythonScript(imagePath) {
  const imageToUse = imagePath || path.join(__dirname, 'python-print', 'media', 'img', 'picture.png');
  return executePythonScript(imageToUse);
}

function executePythonScript(imagePath) {
  if (printProcess && !printProcess.killed) return printProcess;
  const packagedExecutable = path.join(process.resourcesPath, 'print-service', 'terrones-print-service.exe');
  const developmentExecutable = path.join(__dirname, 'dist', 'print-service', 'terrones-print-service.exe');
  const executable = fs.existsSync(packagedExecutable) ? packagedExecutable : developmentExecutable;
  const scriptPath = path.join(__dirname, 'python-print', 'imprimir.py');
  const command = fs.existsSync(executable) ? executable : 'python';
  const args = fs.existsSync(executable) ? [imagePath] : [scriptPath, imagePath];

  if (app.isPackaged && !fs.existsSync(executable)) {
    throw new Error('El servicio autónomo de impresión no está incluido en la instalación.');
  }

  const pythonProcess = spawn(command, args, { windowsHide: true });
  printProcess = pythonProcess;

  pythonProcess.stdout.on("data", (data) => {
    console.log(`stdout: ${data}`);
    logger.info(`stdout: ${data}`);
  });

  pythonProcess.stderr.on("data", (data) => {
    console.error(`stderr: ${data}`);
    logger.error(`stderr: ${data}`);
  });

  pythonProcess.on("close", (code) => {
    printProcess = null;
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
  return pythonProcess;
}

function printServiceHealth() {
  return new Promise((resolve, reject) => {
    const request = http.get('http://127.0.0.1:3001/health', { timeout: 1500 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`Impresión respondió HTTP ${response.statusCode}.`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Impresión devolvió una respuesta inválida.')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Tiempo de espera agotado.')));
    request.on('error', reject);
  });
}

async function waitForPrintService(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { return await printServiceHealth(); } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`El servicio local de impresión no inició: ${lastError?.message || 'sin respuesta'}`);
}

function checkAndSelectImage(selectedURL) {
  const safeStoreName = storeKey(selectedURL);
  const userDataPath = app.getPath('userData');
  const defaultImagePath = path.join(userDataPath, 'images', `${safeStoreName}.png`);

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



let abierta = false;

ipcMain.on('perform-search', async (event, searchQuery) => {
  try {
    const sanitizedQuery = String(searchQuery || '').replace(/[^a-zA-Z0-9 áéíóúüñÁÉÍÓÚÜÑ-]/g, '').trim();
    if (!sanitizedQuery) throw new Error('La búsqueda está vacía.');
    await shell.openExternal(`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(sanitizedQuery)}`);
    event.sender.send('download-success', 'La búsqueda se abrió en el navegador.');
  } catch (error) {
    logger.warn(`No fue posible abrir la búsqueda web: ${error.message}`);
    event.sender.send('download-error', 'La búsqueda web requiere conexión.');
  }
});

ipcMain.on('close-window', (event) => {
  const win = BrowserWindow.getFocusedWindow();
  setTimeout(() => {
    abierta = false;
    win.close();
  }, 1000);
});

const logDirectory = path.join(app.getPath('userData'), 'logs');
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

autoUpdater.on('error', (error) => {
  logger.warn(`Actualización no disponible: ${error.message}`);
});
autoUpdater.on('update-downloaded', async (info) => {
  const result = await dialog.showMessageBox({
    type: 'info',
    buttons: ['Reiniciar ahora', 'Después'],
    defaultId: 0,
    cancelId: 1,
    title: 'Actualización lista',
    message: `Terrones POS ${info.version} está listo para instalar.`,
  });
  if (result.response === 0) autoUpdater.quitAndInstall();
});

function createWindow(url) {
  logger.info("Creando nueva ventana.");

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
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
        showRuntimeError(`No fue posible cargar el POS local: ${error.message}`);
    });

  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
      logger.error(`Error ${errorCode} cargando ${validatedURL}: ${errorDescription}`);
      showRuntimeError(`El POS local dejó de responder (${errorCode}: ${errorDescription}).`);
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
                      nodeIntegration: false,
                      contextIsolation: true,
                      sandbox: true,
                      preload: path.join(__dirname, 'preload.js'),
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

      if (input.key === "F9") {
          createStartupWindow(false);
          sendRuntimeStatus(currentRuntimeStatus);
      }
  });

  logger.info("Configuración de eventos de la ventana completada.");
}


async function createImageSelectionWindow(selectedURL) {
  const safeStoreName = storeKey(selectedURL);
  const result = await dialog.showOpenDialog({
    title: 'Selecciona el logo para tickets y cortes',
    properties: ['openFile'],
    filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;

  const imageDirPath = path.join(app.getPath('userData'), 'images');
  fs.mkdirSync(imageDirPath, { recursive: true });
  const savedImagePath = path.join(imageDirPath, `${safeStoreName}.png`);
  const image = nativeImage.createFromPath(result.filePaths[0]);
  if (image.isEmpty()) throw new Error('La imagen seleccionada no es válida.');
  const resized = image.resize({ width: 288, height: 288, quality: 'best' });
  fs.writeFileSync(savedImagePath, resized.toPNG());
  return savedImagePath;
}

function storeKey(selectedURL) {
  try {
    const parsed = new URL(selectedURL);
    return `${parsed.hostname}-${parsed.port || 'default'}`.replace(/[^A-Za-z0-9_.-]/g, '_');
  } catch (_) {
    return 'terrones-pos-local';
  }
}

function sendRuntimeStatus(status) {
  currentRuntimeStatus = status;
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('runtime:status-changed', status);
  }
}

function createStartupWindow(closeWhenReady = true) {
  if (startupWindow && !startupWindow.isDestroyed()) {
    startupWindow.show();
    startupWindow.focus();
    return startupWindow;
  }
  startupWindow = new BrowserWindow({
    width: 720,
    height: 560,
    resizable: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  startupWindow.closeWhenReady = closeWhenReady;
  startupWindow.loadFile(path.join(__dirname, 'vistas', 'startup.html'));
  startupWindow.on('closed', () => { startupWindow = null; });
  return startupWindow;
}

function showRuntimeError(message) {
  sendRuntimeStatus({ state: 'error', phase: 'runtime', message: 'No fue posible iniciar Terrones POS', error: message });
  createStartupWindow(false);
}

async function bootLocalFirst() {
  if (bootPromise) return bootPromise;
  createStartupWindow(true);
  bootPromise = (async () => {
    try {
      const result = await localRuntime.ensureLocalRuntime(sendRuntimeStatus);
      const selectedURL = localRuntime.LOCAL_URL;
      let imagePath = await checkAndSelectImage(selectedURL);
      if (!imagePath) imagePath = await createImageSelectionWindow(selectedURL);
      sendRuntimeStatus({ state: 'starting', phase: 'printing', message: 'Comprobando servicio de impresión…' });
      runPythonScript(imagePath || path.join(__dirname, 'python-print', 'media', 'img', 'picture.png'));
      const printHealth = await waitForPrintService();
      if (!printHealth.printerConfigured) {
        logger.warn(`No hay impresora predeterminada: ${printHealth.printerError || 'no configurada'}`);
      }
      createWindow(selectedURL);
      sendRuntimeStatus({ ...result, printing: printHealth, sync: localRuntime.readSyncStatus() });
      if (startupWindow && startupWindow.closeWhenReady) startupWindow.close();

      autoUpdater.autoDownload = true;
      setTimeout(() => autoUpdater.checkForUpdatesAndNotify().catch((error) => logger.warn(error.message)), 15000);
    } catch (error) {
      logger.error(`Error iniciando runtime local: ${error.stack || error.message}`);
      showRuntimeError(error.message);
    } finally {
      bootPromise = null;
    }
  })();
  return bootPromise;
}

ipcMain.handle('runtime:retry', () => bootLocalFirst());
ipcMain.handle('runtime:status', () => ({ ...currentRuntimeStatus, sync: localRuntime.readSyncStatus() }));
ipcMain.handle('runtime:diagnostics', () => localRuntime.diagnostics());
ipcMain.on('runtime:show-status', () => {
  createStartupWindow(false);
  sendRuntimeStatus({ ...currentRuntimeStatus, sync: localRuntime.readSyncStatus() });
});

app.whenReady().then(async () => {
  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: false });
  await bootLocalFirst();
});

app.on("activate", () => {
  logger.info("Aplicación activada.");
  if (BrowserWindow.getAllWindows().length === 0) {
    bootLocalFirst();
  }
});

app.on('before-quit', () => {
  if (printProcess && !printProcess.killed) printProcess.kill();
});

logger.info("Fin del script.");

// Manejar globalmente las promesas no gestionadas
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
