const { app, BrowserWindow, WebContentsView, clipboard, dialog, ipcMain, nativeImage, powerMonitor, shell } = require("electron");
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
// Automatic releases: the prompt on screen, and the release the cashier postponed.
let autoPromptWindow = null;
let autoPrompt = null;
let autoSnoozedKey = null;
let autoCheckTimer = null;
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
    width: 820,
    height: 720,
    minWidth: 560,
    minHeight: 480,
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
      // Opened again in the middle of an update: starting Docker here would bring back
      // the POS the updater stopped to back it up.
      if (updateRuntime.updateActivity().active) {
        if (!await waitForUpdate()) return;
        sendRuntimeStatus({ state: 'starting', phase: 'bootstrap', message: 'Preparando tu punto de venta…' });
      }
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
      // Nobody is selling yet: the best moment for a release published as automatic.
      const automatic = await installAutomaticUpdateAtStartup();
      if (automatic === 'closing' || quitting) return;
      let runtime = result;
      if (automatic === 'installed') {
        sendRuntimeStatus({ state: 'starting', phase: 'bootstrap', message: 'Preparando tu punto de venta…' });
        runtime = await localRuntime.ensureLocalRuntime(sendRuntimeStatus);
        if (quitting) return;
      }
      await prepareLocalSession(runtime, false);
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
  startAutomaticUpdateChecks();
  return { ok: true };
}

ipcMain.handle('runtime:retry', () => bootLocalFirst());
ipcMain.handle('runtime:open-pos', () => { assertNoUpdateRunning(); return openPreparedPos(); });
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

// What the status window shows besides sync and updates: is the POS answering, is there
// a printer, and when was the last backup.
function supportLogDirectories() {
  return { visor: logDirectory, pos: path.join(updateRuntime.pathsFor().root, 'logs') };
}
ipcMain.handle('support:summary', async () => {
  const activeProfileId = profileStore.getActiveProfileId();
  let printing;
  try {
    const health = await printServiceHealth();
    printing = { running: true, printerConfigured: Boolean(health.printerConfigured), printer: health.printer || '', error: health.printerError || '' };
  } catch (error) {
    printing = { running: false, printerConfigured: false, printer: '', error: error.message };
  }
  let backup = null;
  try { backup = activeProfileId ? localRuntime.latestBackup(activeProfileId) : null; } catch (_) { backup = null; }
  return {
    posReady: await localRuntime.localHealth(),
    posShown: Boolean(mainWindow) && !mainWindow.isPreparing(),
    printing,
    backup,
    updaterFeatures: updateRuntime.updaterFeatures(),
    logs: supportLogDirectories(),
  };
});
ipcMain.handle('support:copy-diagnostics', async () => {
  const activeProfileId = profileStore.getActiveProfileId();
  const diagnostics = activeProfileId ? await localRuntime.diagnostics(activeProfileId) : { message: 'No hay una tienda instalada.' };
  const updates = updateRuntime.getStatus(app.getVersion());
  clipboard.writeText(JSON.stringify({ generatedAt: new Date().toISOString(), visor: app.getVersion(), updates, diagnostics }, null, 2));
  return true;
});
ipcMain.handle('support:open-logs', async (_event, which) => {
  const directory = supportLogDirectories()[which === 'visor' ? 'visor' : 'pos'];
  if (!fs.existsSync(directory)) throw new Error('Todavía no hay registros en esa carpeta.');
  const failure = await shell.openPath(directory);
  if (failure) throw new Error(failure);
  return true;
});
ipcMain.handle('profiles:list', () => ({
  activeProfileId: profileStore.getActiveProfileId(),
  installed: localRuntime.listProfileStatus(),
  catalog: profileStore.catalog(),
}));
ipcMain.handle('profiles:switch', async (_event, profileId) => {
  if (profileOperationPending) throw new Error('Ya hay una operación de tienda en curso.');
  assertNoUpdateRunning();
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
  assertNoUpdateRunning();
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
  assertNoUpdateRunning();
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

// Shown whenever the visor is closed during an update: always with an updater that waits
// for visor-web to exit before starting, and only for the visor's own step otherwise.
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

function closeForUpdate(activity, reason) {
  const request = activity.request || {};
  showUpdateProgress(request.posVersion || request.visorVersion, request.requestedAt || new Date().toISOString());
  logger.info(reason);
  setTimeout(() => app.quit(), 500);
}

// The POS stays covered while the updater works, so nobody sells against a database
// being backed up or migrated, and the visor starts nothing in Docker meanwhile.
// A light update (no new migrations) touches no database: the POS stays open while the
// release loads and is covered only when the updater is about to restart it.
// Resolves with the final activity (covered says whether the POS was ever hidden), or
// null when the visor closes for its own step.
async function waitForUpdate({ expectLight = false } = {}) {
  let covered = false;
  const posShowing = Boolean(mainWindow) && !mainWindow.isPreparing();
  for (;;) {
    if (quitting) return null;
    const activity = updateRuntime.updateActivity();
    if (!activity.active) return { ...activity, covered };
    if (!activity.request?.visorOpen) {
      closeForUpdate(activity, 'Actualización en curso con un actualizador que espera el cierre del visor; cerrando.');
      return null;
    }
    if (activity.progress?.phase === 'visor') {
      closeForUpdate(activity, 'El actualizador va a instalar el visor; cerrando.');
      return null;
    }
    // Until the updater says which kind it is, trust what the visor predicted.
    const light = activity.light === null ? expectLight : activity.light;
    const restarting = ['start', 'verify'].includes(activity.progress?.phase);
    if (!covered && !(posShowing && light && !restarting)) {
      createStartupWindow(false);
      covered = true;
    }
    if (covered) {
      sendRuntimeStatus({
        state: 'updating',
        phase: 'update',
        updatePhase: activity.progress?.phase || 'prepare',
        message: activity.progress?.message || 'Preparando la actualización…',
        version: activity.request?.posVersion || activity.request?.visorVersion || '',
        // A light update has no backup step to show.
        light: activity.light === true,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

function assertNoUpdateRunning() {
  if (updateRuntime.updateActivity().active) throw new Error('Hay una actualización en curso; espera a que termine.');
}

async function followUpdateInWindow(options = {}) {
  const finished = await waitForUpdate(options);
  if (!finished) return;
  updateInstallPending = false;
  if (finished.progress?.phase === 'failed') {
    const message = finished.progress.message || 'La actualización no se completó.';
    if (!finished.covered) {
      // A light update that failed before restarting the POS never interrupted the sale.
      logger.warn(`Actualización ligera sin completar: ${message} ${finished.progress.error || ''}`);
      dialog.showMessageBox(posWindow || undefined, {
        type: 'warning', buttons: ['Entendido'], title: 'Actualización', message,
        detail: [finished.progress.error, 'Terrones POS sigue con la versión anterior. Puedes revisar el detalle con F9.'].filter(Boolean).join('\n\n'),
      }).catch(() => {});
      return;
    }
    sendRuntimeStatus({
      state: 'update_failed',
      phase: 'update',
      message,
      error: finished.progress.error || '',
    });
    return;
  }
  // Reloads the POS so the page comes from the version that was just installed.
  await bootLocalFirst();
}

// Shared by the Install button and by automatic releases. Refuses before asking or
// closing anything, so the POS is never interrupted for an update that cannot run.
async function startInstall({ automatic = false } = {}) {
  if (updateInstallPending) throw new Error('Ya se está solicitando una actualización.');
  updateInstallPending = true;
  try {
    const check = await updateRuntime.preflight({ visorVersion: app.getVersion(), checkDatabase: checkActiveDatabase });
    if (!check.ok) throw new Error(check.problems.join(' '));
    // An updater registered before 2026.11.01.4 waits for the visor to exit first.
    const visorOpen = updateRuntime.updaterFeatures().includes('visor-abierto');
    const light = visorOpen && check.status.light;
    if (!automatic) {
      const modalVisible = await posSaleInProgress({ modalOnly: true });
      const visorStep = check.status.available.visor
        ? ' Al final el visor se cerrará un momento para actualizarse y se abrirá solo.'
        : '';
      const confirmation = await dialog.showMessageBox(statusWindow || undefined, {
        type: modalVisible ? 'warning' : 'question',
        buttons: [visorOpen ? 'Instalar actualización' : 'Instalar y cerrar el POS', 'Cancelar'],
        defaultId: 1,
        cancelId: 1,
        title: 'Instalar actualización',
        message: modalVisible
          ? 'Hay una ventana de cobro abierta.'
          : (light
            ? 'Terrones POS se reiniciará unos segundos al final.'
            : (visorOpen ? 'Terrones POS no se podrá usar durante la actualización.' : 'La actualización cerrará Terrones POS durante unos minutos.')),
        detail: (light
          ? 'Esta versión no cambia la base de datos: puedes seguir vendiendo mientras se prepara. Al final el POS se reinicia unos segundos; termina o cancela el cobro que tengas abierto cuando aparezca el aviso.'
          : 'Cancela cualquier cobro o abono en curso y confirma que no hay una venta editándose antes de continuar.\n\n'
            + (visorOpen
              ? 'Esta ventana mostrará el avance (de 5 a 10 minutos) y el POS volverá solo al terminar.'
              : 'Una ventana mostrará el avance (de 5 a 10 minutos). Terrones POS se abrirá solo al terminar.'))
          + visorStep,
      });
      if (confirmation.response !== 0) {
        updateInstallPending = false;
        return { canceled: true };
      }
    }
    const requestedAt = new Date().toISOString();
    const result = await updateRuntime.requestInstall({
      visorVersion: app.getVersion(), visorExecutable: process.execPath, visorOpen, checkDatabase: checkActiveDatabase,
    });
    if (automatic) updateRuntime.recordAutoAttempt(check.status.key);
    logger.info(`Actualización ${automatic ? 'automática' : 'manual'} solicitada (${check.status.key}); ${light ? 'ligera' : 'completa'}.`);
    return { ...result, visorOpen, light, requestedAt, version: check.status.available.pos || check.status.available.visor };
  } catch (error) {
    updateInstallPending = false;
    throw error;
  }
}

// Whether somebody is in the middle of a sale: a dialog open in the POS, or products
// in the cart. A page that does not answer in time counts as busy, so an automatic
// release never interrupts a sale; a cart that cannot be read (nobody signed in, POS
// not answering) means there is no sale to interrupt.
async function posSaleInProgress({ modalOnly = false } = {}) {
  if (!mainWindow || mainWindow.contents.isDestroyed() || mainWindow.isPreparing()) return false;
  const script = `(async () => {
    if (document.querySelector('.modal.show,[role=dialog][open],.swal2-container')) return true;
    if (${modalOnly ? 'true' : 'false'}) return false;
    try {
      const response = await fetch('/vender/obtenerCarrito.php', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) return false;
      const data = await response.json();
      return Boolean(data && !data.error && data.carrito && Array.isArray(data.carrito.productos) && data.carrito.productos.length);
    } catch (_) { return false; }
  })()`;
  try {
    return await Promise.race([
      mainWindow.contents.executeJavaScript(script, true),
      new Promise((resolve) => setTimeout(() => resolve(!modalOnly), 4000)),
    ]);
  } catch (_) {
    return !modalOnly;
  }
}

// Runs the request that startInstall accepted: closes the visor for an old updater, or
// follows the update in this window.
function continueInstall(result) {
  if (!result.visorOpen) {
    showUpdateProgress(result.version, result.requestedAt);
    logger.info('Actualización verificada solicitada; cerrando el visor.');
    setTimeout(() => app.quit(), 500);
    return;
  }
  if (statusWindow && !statusWindow.isDestroyed()) statusWindow.close();
  followUpdateInWindow({ expectLight: result.light }).catch((error) => {
    updateInstallPending = false;
    showRuntimeError(error.message);
  });
}

// 'continue' opens the POS as usual, 'installed' means the containers were replaced and
// 'closing' means the visor is quitting so the updater can work.
async function installAutomaticUpdateAtStartup() {
  let key = null;
  try {
    const status = updateRuntime.getStatus(app.getVersion());
    if (!updateRuntime.autoInstallDecision(status, { atStartup: true, snoozedKey: autoSnoozedKey }).install) return 'continue';
    key = status.key;
    const result = await startInstall({ automatic: true });
    if (!result.visorOpen) {
      showUpdateProgress(result.version, result.requestedAt);
      setTimeout(() => app.quit(), 500);
      return 'closing';
    }
    const finished = await waitForUpdate();
    updateInstallPending = false;
    if (!finished) return 'closing';
    if (finished.progress?.phase === 'failed') {
      logger.warn(`La actualización automática no se completó: ${finished.progress.message || ''} ${finished.progress.error || ''}`);
    }
    return 'installed';
  } catch (error) {
    // The release stays available in F9; opening the store matters more than updating.
    updateInstallPending = false;
    autoSnoozedKey = key || autoSnoozedKey;
    logger.warn(`No se instaló la actualización automática al abrir: ${error.message}`);
    return 'continue';
  }
}

function closeAutoPrompt() {
  const window = autoPromptWindow;
  autoPromptWindow = null;
  autoPrompt = null;
  if (window && !window.isDestroyed()) window.close();
}

function showAutoUpdatePrompt(status) {
  autoPrompt = {
    key: status.key,
    seconds: 60,
    version: [status.available.pos ? `Terrones POS ${status.available.pos}` : '', status.available.visor ? `visor ${status.available.visor}` : ''].filter(Boolean).join(' y '),
    notes: status.notes || '',
    light: Boolean(status.light) && updateRuntime.updaterFeatures().includes('visor-abierto'),
    visor: Boolean(status.available.visor),
  };
  autoPromptWindow = new BrowserWindow({
    width: 520, height: 400, resizable: false, minimizable: false, maximizable: false,
    autoHideMenuBar: true, title: 'Actualización automática',
    parent: posWindow && !posWindow.isDestroyed() ? posWindow : undefined, modal: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') },
  });
  const window = autoPromptWindow;
  window.loadFile(path.join(__dirname, 'vistas', 'auto-update.html'));
  // Closing the prompt without answering postpones the release.
  window.on('closed', () => {
    if (autoPromptWindow !== window) return;
    autoSnoozedKey = autoPrompt?.key || autoSnoozedKey;
    autoPromptWindow = null;
    autoPrompt = null;
  });
}

// With the POS open, an automatic release waits until nobody is using the box.
async function checkAutomaticUpdate() {
  if (quitting || bootPromise || updateInstallPending || autoPromptWindow || profileOperationPending) return;
  if (!mainWindow || mainWindow.isPreparing()) return;
  const status = updateRuntime.getStatus(app.getVersion());
  const decision = updateRuntime.autoInstallDecision(status, { snoozedKey: autoSnoozedKey, idleSeconds: powerMonitor.getSystemIdleTime() });
  if (!decision.install) return;
  if (await posSaleInProgress()) return;
  if (quitting || updateInstallPending || autoPromptWindow) return;
  logger.info(`Actualización automática lista (${status.key}); mostrando el aviso.`);
  showAutoUpdatePrompt(status);
}

function startAutomaticUpdateChecks() {
  if (autoCheckTimer) return;
  autoCheckTimer = setInterval(() => {
    checkAutomaticUpdate().catch((error) => logger.warn(`Revisión de actualización automática: ${error.message}`));
  }, 30000);
}

ipcMain.handle('update:auto-info', (event) => {
  if (!autoPromptWindow || event.sender !== autoPromptWindow.webContents || !autoPrompt) throw new Error('No hay una actualización automática pendiente.');
  return autoPrompt;
});
ipcMain.handle('update:auto-respond', async (event, answer) => {
  if (!autoPromptWindow || event.sender !== autoPromptWindow.webContents || !autoPrompt) throw new Error('No hay una actualización automática pendiente.');
  const { key } = autoPrompt;
  if (answer !== 'install') {
    autoSnoozedKey = key;
    logger.info(`Actualización automática pospuesta (${key}) hasta volver a abrir Terrones POS.`);
    closeAutoPrompt();
    return { postponed: true };
  }
  closeAutoPrompt();
  // Somebody may have come back during the countdown.
  if (await posSaleInProgress()) {
    logger.info('Actualización automática detenida: hay una venta en curso.');
    return { postponed: true };
  }
  try {
    continueInstall(await startInstall({ automatic: true }));
    return { ok: true };
  } catch (error) {
    logger.warn(`No se instaló la actualización automática: ${error.message}`);
    autoSnoozedKey = key;
    return { ok: false, error: error.message };
  }
});

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
  if (autoPromptWindow) closeAutoPrompt();
  const result = await startInstall();
  if (result.canceled) return result;
  continueInstall(result);
  return { ok: true, triggered: result.triggered };
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
