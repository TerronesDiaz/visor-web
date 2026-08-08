const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } = require("electron");
const winston = require("winston");
const fs = require("fs");
const { spawn } = require("child_process");
const http = require("http");
const path = require('path');
const localRuntime = require('./local-runtime');
const updateRuntime = require('./update-runtime');
const { resolveStoredLogo, storeKey } = require('./logo-store');

let printProcess = null;
let startupWindow = null;
let statusWindow = null;
let bootPromise = null;
let importPromise = null;
let updateInstallPending = false;
let pendingRuntime = null;
let posWindow = null;
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

async function checkAndSelectImage(selectedURL) {
  try {
    const result = resolveStoredLogo(app.getPath('userData'), selectedURL);
    if (result.migratedFrom) {
      logger.info(`Logo anterior migrado automáticamente desde ${result.migratedFrom} a ${result.path}.`);
    } else if (result.path) {
      logger.info(`Logo encontrado y válido: ${result.path}.`);
    }
    return result.path || false;
  } catch (error) {
    logger.error(`No fue posible reutilizar el logo anterior: ${error.message}`);
    return false;
  }
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

function createWindow(url) {
  if (posWindow && !posWindow.isDestroyed()) {
    posWindow.show();
    posWindow.focus();
    return posWindow;
  }
  logger.info("Creando nueva ventana.");

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
});


  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
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
          logger.info("Tecla F12 presionada. Cerrando la aplicación...");
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
          createStatusWindow();
          sendRuntimeStatus(currentRuntimeStatus);
      }
  });

  logger.info("Configuración de eventos de la ventana completada.");
  posWindow = win;
  win.on('closed', () => { posWindow = null; });
  return win;
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

function createStatusWindow() {
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.show();
    statusWindow.focus();
    return statusWindow;
  }
  statusWindow = new BrowserWindow({
    width: 620,
    height: 600,
    resizable: true,
    autoHideMenuBar: true,
    parent: posWindow && !posWindow.isDestroyed() ? posWindow : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  statusWindow.loadFile(path.join(__dirname, 'vistas', 'status.html'));
  statusWindow.on('closed', () => { statusWindow = null; });
  return statusWindow;
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
      const provisioning = localRuntime.readProvisioningInfo();
      if (!provisioning.provisioned) {
        startupWindow.closeWhenReady = false;
        sendRuntimeStatus({
          state: 'needs_provision',
          phase: 'provision',
          message: 'Falta copiar la información de la tienda',
          recipient: provisioning.recipient,
          sync: localRuntime.readSyncStatus(),
        });
        return;
      }
      await prepareLocalSession(result, false);
    } catch (error) {
      logger.error(`Error iniciando runtime local: ${error.stack || error.message}`);
      showRuntimeError(error.message);
    } finally {
      bootPromise = null;
    }
  })();
  return bootPromise;
}

async function prepareLocalSession(result, waitForConfirmation) {
  const selectedURL = localRuntime.LOCAL_URL;
  let imagePath = await checkAndSelectImage(selectedURL);
  if (!imagePath) imagePath = await createImageSelectionWindow(selectedURL);
  sendRuntimeStatus({ state: 'starting', phase: 'printing', message: 'Comprobando logo e impresión…' });
  runPythonScript(imagePath || path.join(__dirname, 'python-print', 'media', 'img', 'picture.png'));
  const printHealth = await waitForPrintService();
  if (!printHealth.printerConfigured) {
    logger.warn(`No hay impresora predeterminada: ${printHealth.printerError || 'no configurada'}`);
  }
  pendingRuntime = { ...result, printing: printHealth, sync: localRuntime.readSyncStatus() };
  if (waitForConfirmation) {
    startupWindow.closeWhenReady = false;
    sendRuntimeStatus({
      ...pendingRuntime,
      state: 'ready_to_open',
      phase: 'ready',
      message: 'La copia local está lista para validarse',
    });
    return;
  }
  openPreparedPos();
}

function openPreparedPos() {
  if (!localRuntime.readProvisioningInfo().provisioned) {
    throw new Error('Primero debes restaurar la copia de la tienda.');
  }
  createWindow(localRuntime.LOCAL_URL);
  sendRuntimeStatus(pendingRuntime || {
    state: 'ready',
    phase: 'ready',
    message: 'POS local listo',
    sync: localRuntime.readSyncStatus(),
  });
  if (startupWindow && !startupWindow.isDestroyed()) startupWindow.close();
  return { ok: true };
}

ipcMain.handle('runtime:retry', () => bootLocalFirst());
ipcMain.handle('runtime:open-pos', () => openPreparedPos());
ipcMain.handle('runtime:status', () => ({ ...currentRuntimeStatus, sync: localRuntime.readSyncStatus(), updates: updateRuntime.getStatus(app.getVersion()) }));
ipcMain.handle('runtime:diagnostics', () => localRuntime.diagnostics());
ipcMain.handle('provision:get-info', () => localRuntime.readProvisioningInfo());
ipcMain.handle('provision:copy-recipient', () => {
  const recipient = localRuntime.readProvisioningInfo().recipient;
  if (!recipient) throw new Error('No se encontró la clave pública de esta PC.');
  clipboard.writeText(recipient);
  return true;
});
ipcMain.handle('provision:select-and-import', async () => {
  if (importPromise) return importPromise;
  const selection = await dialog.showOpenDialog(startupWindow || undefined, {
    title: 'Selecciona la copia cifrada de la tienda',
    properties: ['openFile'],
    filters: [{ name: 'Copia de Terrones POS', extensions: ['age'] }],
  });
  if (selection.canceled || !selection.filePaths[0]) return { canceled: true };

  importPromise = (async () => {
    try {
      const restored = await localRuntime.importProvision(selection.filePaths[0], sendRuntimeStatus);
      logger.info(`Aprovisionamiento restaurado: ${JSON.stringify(restored.manifest || {})}`);
      await prepareLocalSession({ state: 'ready', phase: 'ready', message: 'POS local listo', url: localRuntime.LOCAL_URL }, true);
      return { ok: true, manifest: restored.manifest };
    } catch (error) {
      logger.error(`Error restaurando la tienda: ${error.stack || error.message}`);
      showRuntimeError(error.message);
      return { ok: false, error: error.message };
    } finally {
      importPromise = null;
    }
  })();
  return importPromise;
});
ipcMain.on('runtime:show-status', () => {
  createStatusWindow();
  sendRuntimeStatus({ ...currentRuntimeStatus, sync: localRuntime.readSyncStatus() });
});
ipcMain.handle('update:check', () => updateRuntime.getStatus(app.getVersion()));
ipcMain.handle('update:install', async (event) => {
  const senderUrl = event.senderFrame?.url || '';
  if (!senderUrl.endsWith('/vistas/status.html')) throw new Error('La actualización solo puede iniciarse desde la ventana de estado.');
  if (updateInstallPending) throw new Error('Ya se está solicitando una actualización.');
  updateInstallPending = true;
  try {
    let modalVisible = false;
    if (posWindow && !posWindow.isDestroyed()) {
      modalVisible = await posWindow.webContents.executeJavaScript("Boolean(document.querySelector('.modal.show,[role=dialog][open]'))", true).catch(() => false);
    }
    const confirmation = await dialog.showMessageBox(statusWindow || undefined, {
      type: modalVisible ? 'warning' : 'question',
      buttons: ['Instalar y cerrar el POS', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      title: 'Instalar actualización',
      message: modalVisible ? 'Hay una ventana de cobro abierta.' : 'La actualización cerrará Terrones POS durante unos minutos.',
      detail: 'Cancela cualquier cobro o abono en curso y confirma que no hay una venta editándose antes de continuar.',
    });
    if (confirmation.response !== 0) {
      updateInstallPending = false;
      return { canceled: true };
    }
    const result = await updateRuntime.requestInstall({ visorVersion: app.getVersion(), visorExecutable: process.execPath });
    logger.info('Actualización verificada solicitada; cerrando el visor.');
    setTimeout(() => app.quit(), 500);
    return result;
  } catch (error) {
    updateInstallPending = false;
    throw error;
  }
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
