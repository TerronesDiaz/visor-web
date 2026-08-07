const { app } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const LOCAL_URL = 'http://127.0.0.1:8080';
const DOCKER_START_TIMEOUT_MS = 180000;
const APP_START_TIMEOUT_MS = 180000;

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 30000, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runtimeRoot() {
  return process.env.TERRONES_POS_HOME || path.join(process.env.ProgramData || 'C:\\ProgramData', 'TerronesPOS');
}

function runtimePaths() {
  const root = runtimeRoot();
  return {
    root,
    app: path.join(root, 'app'),
    compose: path.join(root, 'app', 'docker-compose.local.yml'),
    env: path.join(root, 'config', '.env.local'),
    state: path.join(root, 'state'),
    syncStatus: path.join(root, 'state', 'sync-status.json'),
    provisioned: path.join(root, 'state', 'provisioned.json'),
    provisionRecipient: path.join(root, 'secrets', 'backup-recipient.txt'),
    provisionImporter: path.join(root, 'app', 'deploy', 'local', 'Import-TerronesProvision.ps1'),
  };
}

function findDockerDesktop() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Docker', 'Docker', 'Docker Desktop.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DockerDesktop', 'Docker Desktop.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe'),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

async function dockerReady() {
  try {
    await execFileAsync('docker.exe', ['version', '--format', '{{.Server.Version}}'], { timeout: 10000 });
    return true;
  } catch (_) {
    return false;
  }
}

async function ensureDocker(report) {
  if (await dockerReady()) return;
  const desktop = findDockerDesktop();
  if (!desktop) {
    throw new Error('Docker Desktop no está instalado. Ejecuta de nuevo el instalador de Terrones POS.');
  }

  report({ phase: 'docker', state: 'starting', message: 'Iniciando Docker Desktop…' });
  spawn(desktop, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  const deadline = Date.now() + DOCKER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await dockerReady()) return;
    await delay(3000);
  }
  throw new Error('Docker Desktop no respondió en tres minutos. Revisa WSL2 y vuelve a intentar.');
}

function readEnvFlag(file, name) {
  if (!fs.existsSync(file)) return false;
  const match = fs.readFileSync(file, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'));
  return Boolean(match && match[1].trim().toLowerCase() === 'true');
}

async function composeUp(paths, report) {
  const args = ['compose', '--env-file', paths.env, '-f', paths.compose];
  if (readEnvFlag(paths.env, 'SYNC_ENABLED')) args.push('--profile', 'sync');
  args.push('up', '-d', '--remove-orphans');
  report({ phase: 'containers', state: 'starting', message: 'Iniciando base de datos y aplicación local…' });
  await execFileAsync('docker.exe', args, { cwd: paths.app, timeout: 180000 });
}

function localHealth() {
  return new Promise((resolve) => {
    const request = http.get(`${LOCAL_URL}/EndPoints/utils/ping.php`, { timeout: 3000 }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

async function waitForApplication(report) {
  const deadline = Date.now() + APP_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await localHealth()) return;
    report({ phase: 'application', state: 'starting', message: 'Esperando al POS local…' });
    await delay(2500);
  }
  throw new Error('El POS local no respondió en tres minutos. Consulta el diagnóstico y reintenta.');
}

function readSyncStatus() {
  const file = runtimePaths().syncStatus;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      state: parsed.state || 'unknown',
      message: parsed.message || 'Sin estado de sincronización',
      updatedAt: parsed.updatedAt || null,
      pendingMedia: Number(parsed.pendingMedia || 0),
      replicaLagSeconds: parsed.replicaLagSeconds ?? null,
      localAppVersion: parsed.localAppVersion || null,
      cloudAppVersion: parsed.cloudAppVersion || null,
      cloudUpdate: parsed.cloudUpdate || null,
    };
  } catch (_) {
    return { state: 'disabled', message: 'Sincronización aún no configurada', updatedAt: null, pendingMedia: 0, replicaLagSeconds: null };
  }
}

function readProvisioningInfo() {
  const paths = runtimePaths();
  let manifest = null;
  let recipient = '';
  try {
    const serialized = fs.readFileSync(paths.provisioned, 'utf8').replace(/^\uFEFF/, '');
    manifest = JSON.parse(serialized);
  } catch (_) {}
  try { recipient = fs.readFileSync(paths.provisionRecipient, 'utf8').trim(); } catch (_) {}
  return { provisioned: Boolean(manifest), recipient, manifest };
}

async function importProvision(bundlePath, report = () => {}) {
  const paths = runtimePaths();
  if (!bundlePath || path.extname(bundlePath).toLowerCase() !== '.age') {
    throw new Error('Selecciona el paquete cifrado de la tienda con extensión .age.');
  }
  if (!fs.existsSync(bundlePath)) throw new Error('El paquete seleccionado ya no existe.');
  if (!fs.existsSync(paths.provisionImporter)) {
    throw new Error('La instalación local no contiene el importador de la tienda.');
  }

  const composeArgs = ['compose', '--env-file', paths.env, '-f', paths.compose];
  report({ phase: 'provision', state: 'provisioning', message: 'Preparando la restauración segura…' });
  await execFileAsync('docker.exe', [...composeArgs, 'stop', 'app'], { cwd: paths.app, timeout: 120000 });

  report({ phase: 'provision', state: 'provisioning', message: 'Restaurando base de datos e imágenes…' });
  const result = await execFileAsync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', paths.provisionImporter,
    '-Bundle', bundlePath, '-RuntimeRoot', paths.root,
  ], { cwd: paths.root, timeout: 1800000, maxBuffer: 10 * 1024 * 1024 });

  if (!readProvisioningInfo().provisioned) {
    throw new Error('La restauración terminó sin confirmar el aprovisionamiento.');
  }
  report({ phase: 'provision', state: 'provisioning', message: 'Iniciando la tienda restaurada…' });
  await composeUp(paths, report);
  await waitForApplication(report);
  return { ...readProvisioningInfo(), output: result.stdout };
}

async function diagnostics() {
  const paths = runtimePaths();
  let containers = '';
  try {
    containers = (await execFileAsync('docker.exe', ['compose', '--env-file', paths.env, '-f', paths.compose, 'ps'], { cwd: paths.app })).stdout;
  } catch (error) {
    containers = error.stderr || error.message;
  }
  return { paths, dockerReady: await dockerReady(), appReady: await localHealth(), containers, provisioning: readProvisioningInfo(), sync: readSyncStatus() };
}

async function ensureLocalRuntime(report = () => {}) {
  const paths = runtimePaths();
  if (!fs.existsSync(paths.compose) || !fs.existsSync(paths.env)) {
    throw new Error(`Instalación local incompleta. Faltan archivos en ${paths.root}.`);
  }
  fs.mkdirSync(paths.state, { recursive: true });
  await ensureDocker(report);
  await composeUp(paths, report);
  await waitForApplication(report);
  const result = { phase: 'ready', state: 'ready', message: 'POS local listo', url: LOCAL_URL, sync: readSyncStatus() };
  report(result);
  return result;
}

module.exports = { LOCAL_URL, diagnostics, ensureLocalRuntime, importProvision, readProvisioningInfo, readSyncStatus, runtimePaths };
