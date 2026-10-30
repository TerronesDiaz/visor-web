const { app, BrowserWindow, WebContentsView, clipboard, dialog, ipcMain, nativeImage, shell } = require("electron");
const winston = require("winston");
const fs = require("fs");
const { spawn } = require("child_process");
const { stopProcessTree } = require('./stop-process-tree');
const http = require("http");
const path = require('path');
const localRuntime = require('./local-runtime');
const { createMainWindow } = require('./main-window');
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
let mainWindow = null;
let quitting = false;
app.on('second-instance', () => {
  if (!posWindow || posWindow.isDestroyed()) return;
  if (posWindow.isMinimized()) posWindow.restore();
  posWindow.show();
  posWindow.focus();
});
const updateRuntime = require('./update-runtime');
const profileStore = require('./profile-store');
const enrollmentRuntime = require('./enrollment-runtime');
const { resolveStoredLogo, storeKey } = require('./logo-store');

let printProcess = null;
let startupWindow = null;
let statusWindow = null;
let bootPromise = null;
let importPromise = null;
let updateInstallPending = false;
let profileOperationPending = false;
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
    if (printProcess === pythonProcess) printProcess = null;
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

async function stopPrintService() {
  if (!printProcess) return;
  const processToStop = printProcess;
  await stopProcessTree(processToStop);
  if (printProcess === processToStop) printProcess = null;
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

function attachPosShortcuts(contents) {
  contents.on("before-input-event", (event, input) => {

      if (input.key === "F12") {
          logger.info("Tecla F12 presionada. Cerrando la aplicación...");
          app.quit();
      }

      if (input.key === "F8") {
          logger.info("Tecla F8 presionada. Abriendo DevTools...");
          contents.openDevTools();
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

}

function ensureMainWindow() {
  if (quitting) return null;
  if (mainWindow && !mainWindow.window.isDestroyed()) return mainWindow;
  mainWindow = createMainWindow({
    BrowserWindow, WebContentsView, onError: showRuntimeError,
    onClosed: () => { mainWindow = null; posWindow = null; startupWindow = null; app.quit(); },
    onPosCreated: attachPosShortcuts,
  });
  posWindow = mainWindow.window;
  startupWindow = posWindow;
  return mainWindow;
}

async function createWindow(url) {
  const host = ensureMainWindow();
  if (!host) return false;
  const loaded = await host.loadPos(url);
  if (!loaded && !quitting) throw host.getLoadError() || new Error('No fue posible abrir la tienda. Reintenta desde la pantalla de inicio.');
  return loaded;
}

async function createImageSelectionWindow(selectedURL) {
  const safeStoreName = storeKey(selectedURL);
  const result = await dialog.showOpenDialog(posWindow || undefined, {
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
  if (quitting) return;
  currentRuntimeStatus = status;
  if (mainWindow && !mainWindow.contents.isDestroyed()) mainWindow.contents.send('runtime:status-changed', status);
  if (mainWindow && !mainWindow.preparationContents.isDestroyed()) mainWindow.preparationContents.send('runtime:status-changed', status);
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('runtime:status-changed', status);
  }
}

function createStartupWindow(closeWhenReady = true) {
  const host = ensureMainWindow();
  if (!host) return null;
  host.showPreparation();
  startupWindow.closeWhenReady = closeWhenReady;
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
  if (quitting) return;
  logger.error(`Error visible del visor: ${message}`);
  sendRuntimeStatus({ state: 'error', phase: 'runtime', message: 'No fue posible iniciar Terrones POS', error: message });
  createStartupWindow(false);
}

async function bootLocalFirst() {
  if (bootPromise) return bootPromise;
  if (quitting) return;
  createStartupWindow(true);
  sendRuntimeStatus({ state: 'starting', phase: 'bootstrap', message: 'Preparando tu punto de venta…' });
  bootPromise = (async () => {
    try {
      const result = await localRuntime.ensureLocalRuntime(sendRuntimeStatus);
      if (quitting) return;
      if (result.state === 'needs_profile') {
        startupWindow.closeWhenReady = false;
        sendRuntimeStatus({ ...result, catalog: profileStore.catalog() });
        return;
      }
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
  if (quitting) return;
  const activeProfile = profileStore.getProfile(profileStore.getActiveProfileId());
  const selectedURL = activeProfile.cloudUrl;
  let imagePath = await checkAndSelectImage(selectedURL);
  if (!imagePath) imagePath = await createImageSelectionWindow(selectedURL);
  if (quitting) return;
  sendRuntimeStatus({ state: 'starting', phase: 'printing', message: 'Preparando impresión…' });
  runPythonScript(imagePath || path.join(__dirname, 'python-print', 'media', 'img', 'picture.png'));
  const printHealth = await waitForPrintService();
  if (quitting) return;
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
  await openPreparedPos();
}

async function openPreparedPos() {
  if (quitting) return { ok: false };
  if (!localRuntime.readProvisioningInfo().provisioned) {
    throw new Error('Primero debes restaurar la copia de la tienda.');
  }
  sendRuntimeStatus({ state: 'starting', phase: 'opening', message: 'Abriendo tienda…' });
  if (!await createWindow(localRuntime.LOCAL_URL)) return { ok: false };
  sendRuntimeStatus(pendingRuntime || {
    state: 'ready',
    phase: 'ready',
    message: 'POS local listo',
    sync: localRuntime.readSyncStatus(),
  });
  return { ok: true };
}

ipcMain.handle('runtime:retry', () => bootLocalFirst());
ipcMain.handle('runtime:open-pos', () => openPreparedPos());
ipcMain.handle('runtime:status', () => {
  const activeProfileId = profileStore.getActiveProfileId();
  return {
    ...currentRuntimeStatus,
    activeProfileId,
    sync: activeProfileId ? localRuntime.readSyncStatus(activeProfileId) : { state: 'disabled', message: 'Elige una tienda.' },
    profiles: localRuntime.listProfileStatus(),
    updates: updateRuntime.getStatus(app.getVersion()),
  };
});
ipcMain.handle('runtime:diagnostics', () => {
  const activeProfileId = profileStore.getActiveProfileId();
  return activeProfileId ? localRuntime.diagnostics(activeProfileId) : { profiles: [], message: 'No hay una tienda instalada.' };
});
ipcMain.handle('profiles:list', () => ({
  activeProfileId: profileStore.getActiveProfileId(),
  installed: localRuntime.listProfileStatus(),
  catalog: profileStore.catalog(),
}));
ipcMain.handle('profiles:switch', async (_event, profileId) => {
  if (profileOperationPending) throw new Error('Ya hay una operación de tienda en curso.');
  profileStore.catalogProfile(profileId);
  const modalVisible = posWindow && !posWindow.isDestroyed()
    ? await mainWindow.contents.executeJavaScript("Boolean(document.querySelector('.modal.show,[role=dialog][open],.swal2-container'))", true).catch(() => false)
    : false;
  if (modalVisible) throw new Error('Cierra primero la ventana de cobro o el diálogo abierto.');
  const target = profileStore.getProfile(profileId);
  const confirmation = await dialog.showMessageBox(statusWindow || posWindow || undefined, {
    type: 'warning', buttons: ['Respaldar y cambiar', 'Cancelar'], defaultId: 1, cancelId: 1,
    title: 'Cambiar tienda', message: `Cambiar a ${target.displayName}`,
    detail: 'Guarda cualquier formulario abierto. Se creará un respaldo antes de cerrar la tienda actual.',
  });
  if (confirmation.response !== 0) return { canceled: true };
  profileOperationPending = true;
  try {
    const result = await localRuntime.switchProfile(profileId, sendRuntimeStatus);
    await stopPrintService();
    let imagePath = await checkAndSelectImage(result.profile.cloudUrl);
    if (!imagePath) imagePath = await createImageSelectionWindow(result.profile.cloudUrl);
    runPythonScript(imagePath || path.join(__dirname, 'python-print', 'media', 'img', 'picture.png'));
    await waitForPrintService();
    if (posWindow && !posWindow.isDestroyed()) {
      await createWindow(localRuntime.LOCAL_URL);
      posWindow.show();
      posWindow.focus();
    } else await createWindow(localRuntime.LOCAL_URL);
    sendRuntimeStatus({ state: 'ready', phase: 'ready', message: `${result.profile.displayName} lista`, profile: result.profile, sync: localRuntime.readSyncStatus(profileId), profiles: localRuntime.listProfileStatus() });
    return result;
  } catch (error) {
    if (posWindow && !posWindow.isDestroyed()) await createWindow(localRuntime.LOCAL_URL).catch(() => {});
    else await createWindow(localRuntime.LOCAL_URL);
    throw error;
  } finally { profileOperationPending = false; }
});
ipcMain.handle('profiles:enroll', async (_event, profileId, code) => {
  if (profileOperationPending) throw new Error('Ya hay una operación de tienda en curso.');
  profileStore.catalogProfile(profileId);
  profileOperationPending = true;
  try {
    const previousProfileId = profileStore.getActiveProfileId();
    const result = await enrollmentRuntime.enroll(
      profileId,
      code,
      (bundle, selectedProfileId) => localRuntime.importProvision(bundle, sendRuntimeStatus, selectedProfileId),
      sendRuntimeStatus,
    );
    if (previousProfileId && previousProfileId !== profileId) {
      await localRuntime.switchProfile(profileId, sendRuntimeStatus);
    } else {
      profileStore.setActiveProfile(profileId);
      await localRuntime.ensureLocalRuntime(sendRuntimeStatus);
    }
    await stopPrintService();
    await prepareLocalSession({ state: 'ready', phase: 'ready', message: `${result.profile.displayName} lista`, profile: result.profile, url: localRuntime.LOCAL_URL }, false);
    return result;
  } finally { profileOperationPending = false; }
});
ipcMain.handle('profiles:finalize', async (_event, profileId) => {
  if (profileOperationPending) throw new Error('Ya hay una operación de tienda en curso.');
  const profile = profileStore.getProfile(profileId);
  const confirmation = await dialog.showMessageBox(statusWindow || posWindow || undefined, {
    type: 'warning', buttons: ['Finalizar y habilitar ventas', 'Cancelar'], defaultId: 1, cancelId: 1,
    title: 'Finalizar configuración', message: `Confirmar ${profile.displayName}`,
    detail: 'Confirma que revisaste usuarios, folios, ventas, saldos, existencias e imágenes. La base del VPS se convertirá en réplica de solo lectura.',
  });
  if (confirmation.response !== 0) return { canceled: true };
  profileOperationPending = true;
  try {
    const result = await enrollmentRuntime.finalize(profileId, sendRuntimeStatus);
    if (profileStore.getActiveProfileId() === profileId) {
      const paths = localRuntime.runtimePaths(profileId);
      await localRuntime.stopApplication(paths);
      await localRuntime.startApplication(paths, sendRuntimeStatus);
      await localRuntime.waitForApplication(sendRuntimeStatus);
      if (posWindow && !posWindow.isDestroyed()) await createWindow(localRuntime.LOCAL_URL);
    }
    sendRuntimeStatus({ state: 'ready', phase: 'ready', message: `${profile.displayName} habilitada para ventas`, profile, sync: localRuntime.readSyncStatus(profileId), profiles: localRuntime.listProfileStatus() });
    return result;
  } finally { profileOperationPending = false; }
});
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
function checkActiveDatabase() {
  const activeProfileId = profileStore.getActiveProfileId();
  return activeProfileId ? localRuntime.assertDatabaseRunning(activeProfileId) : Promise.resolve();
}

// The updater waits for visor-web to exit, so progress is shown by a separate PowerShell window.
function showUpdateProgress(version, requestedAt) {
  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'update', 'Show-UpdateProgress.ps1')
    : path.join(__dirname, 'scripts', 'Show-UpdateProgress.ps1');
  if (!fs.existsSync(script)) {
    logger.warn(`No se encontró la ventana de progreso: ${script}`);
    return;
  }
  const child = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script,
    '-InstallRoot', updateRuntime.pathsFor().root, '-Version', version || '', '-RequestedAt', requestedAt,
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (error) => logger.warn(`No se pudo abrir la ventana de progreso: ${error.message}`));
  child.unref();
}

ipcMain.handle('update:check', () => updateRuntime.getStatus(app.getVersion()));
ipcMain.handle('update:open-log', async () => {
  const status = updateRuntime.getStatus(app.getVersion());
  const log = status.install?.log || status.lastAttempt?.log;
  const logsRoot = path.join(updateRuntime.pathsFor().root, 'logs') + path.sep;
  if (!log || !path.resolve(log).toLowerCase().startsWith(logsRoot.toLowerCase()) || !fs.existsSync(log)) {
    throw new Error('Este intento no dejó un registro detallado.');
  }
  const failure = await shell.openPath(log);
  if (failure) throw new Error(failure);
});
ipcMain.handle('update:install', async (event) => {
  const senderUrl = event.senderFrame?.url || '';
  if (!senderUrl.endsWith('/vistas/status.html')) throw new Error('La actualización solo puede iniciarse desde la ventana de estado.');
  if (updateInstallPending) throw new Error('Ya se está solicitando una actualización.');
  updateInstallPending = true;
  try {
    // Refuse before asking, so the POS is never closed for an update that cannot run.
    const check = await updateRuntime.preflight({ visorVersion: app.getVersion(), checkDatabase: checkActiveDatabase });
    if (!check.ok) throw new Error(check.problems.join(' '));
    let modalVisible = false;
    if (posWindow && !posWindow.isDestroyed()) {
      modalVisible = await mainWindow.contents.executeJavaScript("Boolean(document.querySelector('.modal.show,[role=dialog][open]'))", true).catch(() => false);
    }
    const confirmation = await dialog.showMessageBox(statusWindow || undefined, {
      type: modalVisible ? 'warning' : 'question',
      buttons: ['Instalar y cerrar el POS', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      title: 'Instalar actualización',
      message: modalVisible ? 'Hay una ventana de cobro abierta.' : 'La actualización cerrará Terrones POS durante unos minutos.',
      detail: 'Cancela cualquier cobro o abono en curso y confirma que no hay una venta editándose antes de continuar.\n\n'
        + 'Una ventana mostrará el avance (de 5 a 10 minutos). Terrones POS se abrirá solo al terminar.',
    });
    if (confirmation.response !== 0) {
      updateInstallPending = false;
      return { canceled: true };
    }
    const requestedAt = new Date().toISOString();
    const result = await updateRuntime.requestInstall({
      visorVersion: app.getVersion(), visorExecutable: process.execPath, checkDatabase: checkActiveDatabase,
    });
    showUpdateProgress(check.status.available.pos || check.status.available.visor, requestedAt);
    logger.info('Actualización verificada solicitada; cerrando el visor.');
    setTimeout(() => app.quit(), 500);
    return result;
  } catch (error) {
    updateInstallPending = false;
    throw error;
  }
});

if (primaryInstance) app.whenReady().then(async () => {
  profileStore.initializeCatalog(__dirname, { requireSignature: app.isPackaged });
  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: false });
  await bootLocalFirst();
}).catch((error) => {
  logger.error(`No fue posible validar el catálogo o iniciar el visor: ${error.stack || error.message}`);
  showRuntimeError(error.message);
});

app.on("activate", () => {
  logger.info("Aplicación activada.");
  if (BrowserWindow.getAllWindows().length === 0) {
    bootLocalFirst();
  }
});

let printerShutdownPending = false;
let printerShutdownFinished = false;
app.on('before-quit', (event) => {
  quitting = true;
  if (printerShutdownFinished || !printProcess) return;
  event.preventDefault();
  if (printerShutdownPending) return;
  printerShutdownPending = true;
  stopPrintService().catch((error) => {
    logger.error(`No fue posible cerrar la impresión: ${error.message}`);
  }).finally(() => {
    printerShutdownFinished = true;
    app.quit();
  });
});

logger.info("Fin del script.");

// Manejar globalmente las promesas no gestionadas
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
