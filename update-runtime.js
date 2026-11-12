const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

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

const UPDATER_TASK = 'Terrones POS - Actualizar';
// Written by Install-TerronesRelease.ps1 and Invoke-TerronesUpdate.ps1 (terrones_pos).
const INSTALL_PHASES = ['prepare', 'backup', 'install', 'migrate', 'start', 'verify', 'visor', 'done', 'failed'];
const HISTORY_LIMIT = 20;
// An updater that dies without writing its result must not leave the box "installing" forever.
const STALE_INSTALL_MS = 15 * 60 * 1000;
// The task runs every minute; a request nobody picks up in this time will not be picked up.
const UNCLAIMED_REQUEST_MS = 5 * 60 * 1000;
// An automatic release installs with the POS open only after the box has been unused this long.
const AUTO_IDLE_SECONDS = 120;
// A release that keeps coming back as available must not restart the box forever.
const AUTO_MAX_ATTEMPTS = 2;

function rootPath() {
  return process.env.TERRONES_POS_HOME || path.join(process.env.ProgramData || 'C:\\ProgramData', 'TerronesPOS');
}

function pathsFor(root = rootPath()) {
  return {
    root,
    updates: path.join(root, 'updates'),
    current: path.join(root, 'updates', 'current.json'),
    request: path.join(root, 'updates', 'request.json'),
    downloadStatus: path.join(root, 'state', 'update-download.json'),
    installStatus: path.join(root, 'state', 'update-status.json'),
    installProgress: path.join(root, 'state', 'update-progress.json'),
    history: path.join(root, 'state', 'update-history.json'),
    lock: path.join(root, 'updates', 'install.lock'),
    auto: path.join(root, 'state', 'update-auto.json'),
    capabilities: path.join(root, 'updater', 'capabilities.json'),
    publicKey: path.join(__dirname, 'update-public-key.xml'),
  };
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return fallback; }
}

function xmlValue(xml, name) {
  const match = xml.match(new RegExp(`<${name}>([^<]+)</${name}>`));
  if (!match) throw new Error(`La clave pública no contiene ${name}.`);
  return match[1].replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function publicKeyFromXml(xml) {
  return crypto.createPublicKey({
    key: { kty: 'RSA', n: xmlValue(xml, 'Modulus'), e: xmlValue(xml, 'Exponent') },
    format: 'jwk',
  });
}

function readVerifiedFeed(channel, root = rootPath(), publicKeyFile = path.join(__dirname, 'update-public-key.xml')) {
  const directory = path.join(root, 'updates', 'downloads', channel, 'current');
  const manifestPath = path.join(directory, 'latest.json');
  const signaturePath = path.join(directory, 'latest.json.sig');
  try {
    const bytes = fs.readFileSync(manifestPath);
    const signature = Buffer.from(fs.readFileSync(signaturePath, 'utf8').trim(), 'base64');
    const publicKey = publicKeyFromXml(fs.readFileSync(publicKeyFile, 'utf8'));
    if (!crypto.verify('RSA-SHA256', bytes, publicKey, signature)) throw new Error('Firma inválida.');
    const manifest = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (manifest.schema !== 1 || manifest.channel !== channel || !manifest.version || !manifest.package) throw new Error('Manifiesto incompatible.');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(manifest.package.name)) throw new Error('Nombre de paquete inseguro.');
    const packagePath = path.join(directory, manifest.package.name);
    const stat = fs.statSync(packagePath);
    if (stat.size !== Number(manifest.package.size)) throw new Error('Tamaño incorrecto.');
    const verified = readJson(path.join(directory, '.verified.json'), {});
    if (verified.channel !== channel || String(verified.sha256).toLowerCase() !== String(manifest.package.sha256).toLowerCase()) {
      throw new Error('El agente aún no termina de verificar el paquete.');
    }
    return { ok: true, manifest, packagePath };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function versionParts(value) {
  return String(value || '0').split(/[.-]/).map((part) => /^\d+$/.test(part) ? Number(part) : part);
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    if (av === bv) continue;
    if (typeof av === 'number' && typeof bv === 'number') return av > bv ? 1 : -1;
    return String(av).localeCompare(String(bv), 'en', { numeric: true });
  }
  return 0;
}

// The publisher marks a release as automatic in its signed manifest (install.mode = "auto").
// Anything else, including a manifest signed before the field existed, waits for the button.
function installMode(manifest) {
  return manifest?.install?.mode === 'auto' ? 'auto' : 'manual';
}

// Same rule as Test-LightUpdate in Invoke-TerronesUpdate.ps1: a release whose migrations
// are all applied does not touch the database, so the POS keeps selling while it installs.
function hasNewMigrations(manifest, installed) {
  const names = (list) => (Array.isArray(list) ? list.map((name) => String(name || '')).filter(Boolean) : []);
  const known = names(installed?.requiredMigrations);
  const required = names(manifest?.requiredMigrations);
  if (!installed?.version || !Array.isArray(manifest?.requiredMigrations) || !known.length || !required.length) return true;
  return required.some((name) => !known.includes(name));
}

function updateKey(available) {
  return `${available?.pos || ''}|${available?.visor || ''}`;
}

function autoAttempts(paths, key) {
  const state = readJson(paths.auto, null);
  return state?.key === key ? Number(state.attempts || 0) : 0;
}

function recordAutoAttempt(key, root = rootPath()) {
  const paths = pathsFor(root);
  const attempts = autoAttempts(paths, key) + 1;
  try { writeJsonAtomic(paths.auto, { schema: 1, key, attempts, lastAt: new Date().toISOString() }); } catch (_) { /* best effort */ }
  return attempts;
}

// Whether an automatic release may start by itself right now. The caller still checks
// that no sale is in progress; this only decides from what the box already knows.
function autoInstallDecision(status, { snoozedKey = null, idleSeconds = null, atStartup = false } = {}) {
  if (!status?.canInstall) return { install: false, reason: 'nothing' };
  if (status.mode !== 'auto') return { install: false, reason: 'manual' };
  if (status.auto?.blocked) return { install: false, reason: status.auto.blocked };
  if (snoozedKey && snoozedKey === status.key) return { install: false, reason: 'snoozed' };
  if (!atStartup && !(Number(idleSeconds) >= AUTO_IDLE_SECONDS)) return { install: false, reason: 'in-use' };
  return { install: true, reason: atStartup ? 'startup' : 'idle' };
}

function readInstallProgress(paths) {
  const progress = readJson(paths.installProgress, null);
  if (!progress || !INSTALL_PHASES.includes(progress.phase)) return null;
  return {
    phase: progress.phase,
    message: progress.message || '',
    error: progress.error || '',
    version: progress.version || '',
    log: progress.log || '',
    updatedAt: progress.updatedAt || null,
  };
}

function readHistory(paths) {
  const history = readJson(paths.history, null);
  return Array.isArray(history?.attempts) ? history.attempts : [];
}

function recordHistory(paths, install, progress) {
  const history = readHistory(paths);
  if (!install?.updatedAt || !['completed', 'error'].includes(install.state)) return history;
  if (history.some((entry) => entry.at === install.updatedAt)) return history;
  const attempts = [{
    at: install.updatedAt,
    state: install.state,
    version: install.version || progress?.version || '',
    message: install.message || '',
    error: install.error || '',
    log: progress?.log || '',
  }, ...history].slice(0, HISTORY_LIMIT);
  try { writeJsonAtomic(paths.history, { schema: 1, attempts }); } catch (_) { return history; }
  return attempts;
}

// The updater keeps install.lock open without sharing while it runs. After a restart the
// file stays behind, so only an open that fails with EBUSY means an updater is running.
function lockHeld(paths) {
  try {
    fs.closeSync(fs.openSync(paths.lock, 'r'));
    return false;
  } catch (error) {
    return ['EBUSY', 'EPERM', 'EACCES'].includes(error.code);
  }
}

// Features of the updater installed in ProgramData, which only an administrator replaces.
function updaterFeatures(root = rootPath()) {
  const capabilities = readJson(pathsFor(root).capabilities, null);
  return capabilities?.schema === 1 && Array.isArray(capabilities.features) ? capabilities.features : [];
}

function isStale(install, paths, now = Date.now()) {
  if (install?.state !== 'installing' || lockHeld(paths)) return false;
  const updatedAt = Date.parse(install.updatedAt || '');
  return Number.isFinite(updatedAt) && now - updatedAt > STALE_INSTALL_MS;
}

function modifiedAt(file) {
  try { return fs.statSync(file).mtimeMs; } catch (_) { return 0; }
}

// Whether an update is under way, so the visor neither opens the POS nor touches Docker.
function updateActivity(root = rootPath(), now = Date.now()) {
  const paths = pathsFor(root);
  const request = readJson(paths.request, null);
  // Progress left by an earlier attempt must not be read as this request's.
  const requestedAt = Date.parse(request?.requestedAt || '');
  const latest = readInstallProgress(paths);
  const progress = latest && Number.isFinite(requestedAt) && (Date.parse(latest.updatedAt || '') || 0) < requestedAt - 5000 ? null : latest;
  const installStatus = readJson(paths.installStatus, {}) || {};
  // true/false once the updater decided for this request; null while it has not said.
  const reported = installStatus.state === 'installing' && typeof installStatus.light === 'boolean'
    && (!Number.isFinite(requestedAt) || (Date.parse(installStatus.updatedAt || '') || 0) >= requestedAt - 5000);
  const light = reported ? installStatus.light : null;
  if (lockHeld(paths)) return { active: true, stale: false, request, progress, light };
  if (!request) return { active: false, stale: false, request: null, progress, light };
  const lastSignal = Math.max(
    modifiedAt(paths.request),
    Date.parse(progress?.updatedAt || '') || 0,
    Date.parse(installStatus.updatedAt || '') || 0,
  );
  const waiting = now - lastSignal < UNCLAIMED_REQUEST_MS;
  return { active: waiting, stale: !waiting, request, progress, light };
}

function getStatus(visorVersion, root = rootPath(), publicKeyFile = path.join(__dirname, 'update-public-key.xml')) {
  const paths = pathsFor(root);
  const installed = readJson(paths.current, {});
  const download = readJson(paths.downloadStatus, { state: 'checking', message: 'Esperando al agente de sincronización.' });
  let install = readJson(paths.installStatus, null);
  if (isStale(install, paths)) {
    install = {
      ...install,
      state: 'error',
      message: 'La actualización anterior se interrumpió antes de terminar.',
      error: 'El actualizador dejó de reportar avance. Puedes volver a intentarlo.',
    };
  }
  const installProgress = readInstallProgress(paths);
  const history = recordHistory(paths, install, installProgress);
  const posFeed = readVerifiedFeed('pos', root, publicKeyFile);
  const visorFeed = readVerifiedFeed('visor', root, publicKeyFile);
  const posAvailable = posFeed.ok && compareVersions(posFeed.manifest.version, installed.version) > 0;
  const visorAvailable = visorFeed.ok && compareVersions(visorFeed.manifest.version, visorVersion) > 0;
  const ready = posAvailable || visorAvailable;
  const installing = install?.state === 'installing';
  const failed = install?.state === 'error';
  const available = {
    pos: posAvailable ? posFeed.manifest.version : null,
    visor: visorAvailable ? visorFeed.manifest.version : null,
  };
  const key = updateKey(available);
  // Automatic only when every pending package was published as automatic.
  const modes = [posAvailable ? installMode(posFeed.manifest) : null, visorAvailable ? installMode(visorFeed.manifest) : null].filter(Boolean);
  const mode = modes.length ? (modes.every((value) => value === 'auto') ? 'auto' : 'manual') : null;
  const light = posAvailable && updaterFeatures(root).includes('ligera') && !hasNewMigrations(posFeed.manifest, installed);
  const lastAttempt = history[0] || null;
  const attempts = ready ? autoAttempts(paths, key) : 0;
  // A release that already failed here, or that was tried twice, waits for a person.
  const failedBefore = ready && lastAttempt?.state === 'error' && [available.pos, available.visor].includes(lastAttempt.version);
  const blocked = mode !== 'auto' ? null : (failedBefore ? 'failed' : (attempts >= AUTO_MAX_ATTEMPTS ? 'attempts' : null));
  const state = installing ? 'installing' : (failed ? 'error' : (ready ? 'ready' : (install?.state || download.state)));
  const message = installing
    ? install.message
    : (failed
      ? `${install.message || 'La actualización anterior falló.'}${install.error ? ` ${install.error}` : ''}`
      : (ready ? 'Hay una actualización lista para instalar.' : (install?.message || download.message)));
  return {
    state,
    message,
    error: install?.error || '',
    installed: { pos: installed.version || 'Sin registro', visor: visorVersion, installedAt: installed.installedAt || null },
    available,
    key,
    // 'auto' | 'manual' while something is pending, null otherwise.
    mode,
    // The POS part can install without stopping the sale for more than a few seconds.
    light,
    auto: { attempts, blocked },
    publishedAt: (posAvailable && posFeed.manifest.publishedAt) || (visorAvailable && visorFeed.manifest.publishedAt) || null,
    notes: [posAvailable ? posFeed.manifest.notes : '', visorAvailable ? visorFeed.manifest.notes : ''].filter(Boolean).join('\n\n'),
    canInstall: ready && !installing,
    checkedAt: download.updatedAt || null,
    progress: {
      downloadedBytes: Number(download.downloadedBytes || 0),
      totalBytes: Number(download.totalBytes || 0),
    },
    install: installing && installProgress ? { ...installProgress, light: install.light === true } : null,
    lastAttempt,
    history,
    packageBytes: (posAvailable ? Number(posFeed.manifest.package.size || 0) : 0)
      + (visorAvailable ? Number(visorFeed.manifest.package.size || 0) : 0),
  };
}

function freeBytes(root) {
  try {
    const stats = fs.statfsSync(fs.existsSync(root) ? root : path.parse(root).root);
    return stats.bavail * stats.bsize;
  } catch (_) {
    return null;
  }
}

function formatGigabytes(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

// Everything that would make the updater fail after the POS is closed is checked here first.
async function preflight({ visorVersion, root = rootPath(), checkDatabase, publicKeyFile, free = freeBytes(root) } = {}) {
  const paths = pathsFor(root);
  const status = getStatus(visorVersion, root, publicKeyFile);
  const problems = [];
  if (!status.canInstall) problems.push('No hay una actualización verificada lista para instalar.');
  const activity = updateActivity(root);
  if (activity.active) {
    problems.push('Ya hay una actualización en curso; espera a que termine.');
  } else if (activity.stale) {
    problems.push('La actualización anterior quedó sin terminar y el actualizador no la retomó. Ejecuta una vez Install-TerronesUpdate.ps1 como administrador.');
  }
  try {
    await execFileAsync('schtasks.exe', ['/Query', '/TN', UPDATER_TASK]);
  } catch (_) {
    problems.push('El actualizador no está registrado en Windows. Ejecuta una vez Install-TerronesUpdate.ps1 como administrador.');
  }
  // The package is expanded, loaded into Docker and backed up while the old version is kept.
  const required = status.packageBytes * 3 + 1024 ** 3;
  if (status.packageBytes && free !== null && free < required) {
    problems.push(`Espacio insuficiente en disco: hay ${formatGigabytes(free)} libres y se necesitan ${formatGigabytes(required)}.`);
  }
  if (status.available.pos && checkDatabase) {
    try { await checkDatabase(); } catch (error) { problems.push(error.message); }
  }
  return { ok: problems.length === 0, problems, status };
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, file);
}

async function requestInstall({ visorVersion, visorExecutable, visorOpen = false, root = rootPath(), checkDatabase }) {
  const check = await preflight({ visorVersion, root, checkDatabase });
  if (!check.ok) throw new Error(check.problems.join(' '));
  const { status } = check;
  const paths = pathsFor(root);
  writeJsonAtomic(paths.request, {
    schema: 1,
    posVersion: status.available.pos,
    visorVersion: status.available.visor,
    visorExecutable,
    visorOpen,
    requestedAt: new Date().toISOString(),
  });
  let triggered = true;
  try {
    await execFileAsync('schtasks.exe', ['/Run', '/TN', UPDATER_TASK]);
  } catch (_) {
    // La tarea también se ejecuta cada minuto; conservar la solicitud evita
    // perder una actualización por un fallo transitorio de /Run.
    triggered = false;
  }
  return { ok: true, triggered };
}

module.exports = {
  AUTO_IDLE_SECONDS, AUTO_MAX_ATTEMPTS, INSTALL_PHASES, autoInstallDecision, compareVersions, getStatus, hasNewMigrations,
  installMode, pathsFor, preflight, publicKeyFromXml, readVerifiedFeed, recordAutoAttempt, requestInstall,
  updateActivity, updaterFeatures,
};
