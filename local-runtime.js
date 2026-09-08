const { execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const profiles = require('./profile-store');
const { configureDockerBackground } = require('./docker-settings');

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

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function runtimeRoot() { return profiles.runtimeRoot(); }
function runtimePaths(profileId) { return profiles.profilePaths(profileId, runtimeRoot()); }
function composeArgs(paths) { return ['compose', '-p', paths.profile.composeProject, '--env-file', paths.env, '-f', paths.compose]; }

function findDockerDesktop() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Docker', 'Docker', 'Docker Desktop.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DockerDesktop', 'Docker Desktop.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe'),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

async function dockerReady() {
  try { await execFileAsync('docker.exe', ['version', '--format', '{{.Server.Version}}'], { timeout: 10000 }); return true; }
  catch (_) { return false; }
}

async function ensureDocker(report) {
  if (await dockerReady()) return;
  if (!findDockerDesktop()) throw new Error('Docker Desktop no está instalado. Ejecuta de nuevo el instalador de Terrones POS.');
  configureDockerBackground();
  report({ phase: 'docker', state: 'starting', message: 'Iniciando servicios…' });
  try {
    await execFileAsync('docker.exe', ['desktop', 'start', '--detach'], { timeout: 15000 });
  } catch (error) {
    throw new Error(`No fue posible iniciar los servicios en segundo plano. Revisa o actualiza Docker Desktop. ${error.stderr || error.message}`);
  }
  const deadline = Date.now() + DOCKER_START_TIMEOUT_MS;
  while (Date.now() < deadline) { if (await dockerReady()) return; await delay(3000); }
  throw new Error('Docker Desktop no respondió en tres minutos. Revisa WSL2 y vuelve a intentar.');
}

function readEnvFlag(file, name) {
  if (!fs.existsSync(file)) return false;
  const match = fs.readFileSync(file, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'));
  return Boolean(match && match[1].trim().toLowerCase() === 'true');
}

async function startBackground(paths, report = () => {}) {
  if (!fs.existsSync(paths.env)) return;
  const args = composeArgs(paths);
  report({ phase: 'containers', state: 'starting', profileId: paths.profile.id, message: `Iniciando servicios de ${paths.profile.displayName}…` });
  await execFileAsync('docker.exe', [...args, 'up', '-d', 'db'], { cwd: paths.app, timeout: 180000 });
  if (readEnvFlag(paths.env, 'SYNC_ENABLED')) {
    await execFileAsync('docker.exe', [...args, '--profile', 'sync', 'up', '-d', 'sync-agent'], { cwd: paths.app, timeout: 180000 });
  }
}

async function startApplication(paths, report = () => {}) {
  await startBackground(paths, report);
  await execFileAsync('docker.exe', [...composeArgs(paths), 'up', '-d', 'app'], { cwd: paths.app, timeout: 180000 });
}

async function stopApplication(paths) {
  if (!fs.existsSync(paths.env)) return;
  await execFileAsync('docker.exe', [...composeArgs(paths), 'stop', 'app'], { cwd: paths.app, timeout: 120000 });
}

function localHealth() {
  return new Promise((resolve) => {
    const request = http.get(`${LOCAL_URL}/EndPoints/utils/ping.php`, { timeout: 3000 }, (response) => {
      response.resume(); resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

async function waitForApplication(report = () => {}) {
  const deadline = Date.now() + APP_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await localHealth()) return;
    report({ phase: 'application', state: 'starting', message: 'Esperando al POS local…' });
    await delay(2500);
  }
  throw new Error('El POS local no respondió en tres minutos. Consulta el diagnóstico y reintenta.');
}

function parseSyncStatus(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return {
      state: parsed.state || 'unknown', message: parsed.message || 'Sin estado de sincronización',
      updatedAt: parsed.updatedAt || null, pendingMedia: Number(parsed.pendingMedia || 0),
      replicaLagSeconds: parsed.replicaLagSeconds ?? null, localAppVersion: parsed.localAppVersion || null,
      cloudAppVersion: parsed.cloudAppVersion || null, cloudUpdate: parsed.cloudUpdate || null,
    };
  } catch (_) {
    return { state: 'disabled', message: 'Sincronización aún no configurada', updatedAt: null, pendingMedia: 0, replicaLagSeconds: null };
  }
}

function readSyncStatus(profileId) { return parseSyncStatus(runtimePaths(profileId).syncStatus); }

function readProvisioningInfo(profileId) {
  const paths = runtimePaths(profileId);
  let manifest = null;
  let recipient = '';
  try { manifest = JSON.parse(fs.readFileSync(paths.provisioned, 'utf8').replace(/^\uFEFF/, '')); } catch (_) {}
  try { recipient = fs.readFileSync(paths.provisionRecipient, 'utf8').trim(); } catch (_) {}
  return { provisioned: Boolean(manifest), recipient, manifest, profile: paths.profile };
}

async function importProvision(bundlePath, report = () => {}, profileId) {
  const paths = runtimePaths(profileId);
  if (!bundlePath || path.extname(bundlePath).toLowerCase() !== '.age') throw new Error('Selecciona el paquete cifrado de la tienda con extensión .age.');
  if (!fs.existsSync(bundlePath)) throw new Error('El paquete seleccionado ya no existe.');
  if (!fs.existsSync(paths.provisionImporter)) throw new Error('La instalación local no contiene el importador de la tienda.');
  report({ phase: 'provision', state: 'provisioning', profileId: paths.profile.id, message: 'Preparando la restauración segura…' });
  await startBackground(paths, report);
  await stopApplication(paths);
  const result = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', paths.provisionImporter,
    '-Bundle', bundlePath, '-RuntimeRoot', paths.root, '-InstallRoot', paths.installRoot,
    '-ProfileId', paths.profile.id, '-ComposeProject', paths.profile.composeProject,
  ], { cwd: paths.root, timeout: 1800000, maxBuffer: 10 * 1024 * 1024 });
  const provisioned = readProvisioningInfo(paths.profile.id);
  if (!provisioned.provisioned || (provisioned.manifest.storeId && provisioned.manifest.storeId !== paths.profile.id)) {
    throw new Error('La restauración terminó sin confirmar el perfil correcto.');
  }
  return { ...provisioned, output: result.stdout };
}

async function runBackup(profileId, tier = 'daily') {
  const paths = runtimePaths(profileId);
  if (!fs.existsSync(paths.backupScript)) throw new Error('No se encontró el script de respaldo.');
  return execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', paths.backupScript,
    '-RuntimeRoot', paths.root, '-InstallRoot', paths.installRoot, '-ProfileId', paths.profile.id,
    '-ComposeProject', paths.profile.composeProject, '-Tier', tier,
  ], { cwd: paths.root, timeout: 1800000, maxBuffer: 10 * 1024 * 1024 });
}

async function switchProfile(profileId, report = () => {}, options = {}) {
  const root = runtimeRoot();
  const previousId = profiles.getActiveProfileId(root);
  if (profileId === previousId) return { ok: true, profile: profiles.getProfile(profileId, root), unchanged: true };
  const target = runtimePaths(profileId);
  if (!readProvisioningInfo(profileId).provisioned) throw new Error(`${target.profile.displayName} todavía no está aprovisionada.`);
  const previous = previousId ? runtimePaths(previousId) : null;
  if (previous && readProvisioningInfo(previousId).provisioned && options.skipBackup !== true) {
    report({ phase: 'backup', state: 'switching', profileId: previousId, message: `Respaldando ${previous.profile.displayName} antes del cambio…` });
    await runBackup(previousId);
  }
  if (previous) await stopApplication(previous);
  profiles.setActiveProfile(profileId, root);
  try {
    report({ phase: 'switch', state: 'switching', profileId, message: `Abriendo ${target.profile.displayName}…` });
    await startApplication(target, report);
    await waitForApplication(report);
    return { ok: true, profile: target.profile, url: LOCAL_URL };
  } catch (error) {
    if (previous) {
      profiles.setActiveProfile(previousId, root);
      await startApplication(previous, report).catch(() => {});
      await waitForApplication(report).catch(() => {});
    }
    throw new Error(`No fue posible abrir ${target.profile.displayName}; se restauró la tienda anterior. ${error.message}`);
  }
}

function listProfileStatus() {
  const activeId = profiles.getActiveProfileId(runtimeRoot());
  return profiles.listProfiles(runtimeRoot()).map((profile) => {
    const provision = readProvisioningInfo(profile.id);
    const paths = runtimePaths(profile.id);
    const enrollmentPending = fs.existsSync(path.join(paths.state, 'enrollment.json')) ||
      (provision.provisioned && fs.existsSync(path.join(paths.root, 'secrets', 'enrollment-attempt.json')));
    return { ...profile, active: profile.id === activeId, provisioned: provision.provisioned, enrollmentPending, sync: readSyncStatus(profile.id) };
  });
}

async function diagnostics(profileId) {
  const paths = runtimePaths(profileId);
  let containers = '';
  try { containers = (await execFileAsync('docker.exe', [...composeArgs(paths), 'ps'], { cwd: paths.app })).stdout; }
  catch (error) { containers = error.stderr || error.message; }
  return { profile: paths.profile, paths, dockerReady: await dockerReady(), appReady: paths.profile.id === profiles.getActiveProfileId(runtimeRoot()) ? await localHealth() : null, containers, provisioning: readProvisioningInfo(paths.profile.id), sync: readSyncStatus(paths.profile.id) };
}

async function ensureLocalRuntime(report = () => {}) {
  const installed = profiles.listProfiles(runtimeRoot());
  if (!installed.length) return { phase: 'profiles', state: 'needs_profile', message: 'Elige una tienda para comenzar.', profiles: [] };
  const activeId = profiles.getActiveProfileId(runtimeRoot());
  const active = runtimePaths(activeId);
  if (!fs.existsSync(active.compose) || !fs.existsSync(active.env)) throw new Error(`Instalación local incompleta para ${active.profile.displayName}.`);
  await ensureDocker(report);
  for (const profile of installed) {
    const paths = runtimePaths(profile.id);
    if (fs.existsSync(paths.env)) {
      if (profile.id !== activeId) await stopApplication(paths).catch(() => {});
      await startBackground(paths, report);
    }
  }
  await startApplication(active, report);
  await waitForApplication(report);
  const result = { phase: 'ready', state: 'ready', message: `${active.profile.displayName} lista`, profile: active.profile, url: LOCAL_URL, sync: readSyncStatus(activeId), profiles: listProfileStatus() };
  report(result);
  return result;
}

module.exports = {
  LOCAL_URL, diagnostics, ensureLocalRuntime, importProvision, listProfileStatus, localHealth,
  readProvisioningInfo, readSyncStatus, runBackup, runtimePaths, startApplication, stopApplication,
  startBackground, switchProfile, waitForApplication,
};
