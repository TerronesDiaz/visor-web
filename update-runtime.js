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

function isStale(install, paths, now = Date.now()) {
  if (install?.state !== 'installing' || fs.existsSync(paths.lock)) return false;
  const updatedAt = Date.parse(install.updatedAt || '');
  return Number.isFinite(updatedAt) && now - updatedAt > STALE_INSTALL_MS;
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
    installed: { pos: installed.version || 'Sin registro', visor: visorVersion },
    available: {
      pos: posAvailable ? posFeed.manifest.version : null,
      visor: visorAvailable ? visorFeed.manifest.version : null,
    },
    notes: [posAvailable ? posFeed.manifest.notes : '', visorAvailable ? visorFeed.manifest.notes : ''].filter(Boolean).join('\n\n'),
    canInstall: ready && !installing,
    checkedAt: download.updatedAt || null,
    progress: {
      downloadedBytes: Number(download.downloadedBytes || 0),
      totalBytes: Number(download.totalBytes || 0),
    },
    install: installing ? installProgress : null,
    lastAttempt: history[0] || null,
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
  if (fs.existsSync(paths.request) || fs.existsSync(paths.lock)) {
    problems.push('Ya hay una actualización en curso; espera a que termine.');
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

async function requestInstall({ visorVersion, visorExecutable, root = rootPath(), checkDatabase }) {
  const check = await preflight({ visorVersion, root, checkDatabase });
  if (!check.ok) throw new Error(check.problems.join(' '));
  const { status } = check;
  const paths = pathsFor(root);
  writeJsonAtomic(paths.request, {
    schema: 1,
    posVersion: status.available.pos,
    visorVersion: status.available.visor,
    visorExecutable,
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
  INSTALL_PHASES, compareVersions, getStatus, pathsFor, preflight, publicKeyFromXml, readVerifiedFeed, requestInstall,
};
