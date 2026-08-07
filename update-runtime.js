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

function getStatus(visorVersion, root = rootPath()) {
  const paths = pathsFor(root);
  const installed = readJson(paths.current, {});
  const download = readJson(paths.downloadStatus, { state: 'checking', message: 'Esperando al agente de sincronización.' });
  const install = readJson(paths.installStatus, null);
  const posFeed = readVerifiedFeed('pos', root);
  const visorFeed = readVerifiedFeed('visor', root);
  const posAvailable = posFeed.ok && compareVersions(posFeed.manifest.version, installed.version) > 0;
  const visorAvailable = visorFeed.ok && compareVersions(visorFeed.manifest.version, visorVersion) > 0;
  const ready = posAvailable || visorAvailable;
  const state = install?.state === 'installing' ? 'installing' : (ready ? 'ready' : (install?.state || download.state));
  const message = install?.state === 'installing' ? install.message : (ready ? 'Hay una actualización lista para instalar.' : (install?.message || download.message));
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
    canInstall: ready && install?.state !== 'installing',
    checkedAt: download.updatedAt || null,
    progress: {
      downloadedBytes: Number(download.downloadedBytes || 0),
      totalBytes: Number(download.totalBytes || 0),
    },
  };
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, file);
}

async function requestInstall({ visorVersion, visorExecutable, root = rootPath() }) {
  const status = getStatus(visorVersion, root);
  if (!status.canInstall) throw new Error('No hay una actualización verificada lista para instalar.');
  const paths = pathsFor(root);
  if (fs.existsSync(paths.request)) throw new Error('Ya hay una actualización solicitada.');
  try {
    await execFileAsync('schtasks.exe', ['/Query', '/TN', 'Terrones POS - Actualizar']);
  } catch (_) {
    throw new Error('El trabajador de actualización aún no está registrado. Instala primero Terrones POS 2026.08.07.2.');
  }
  writeJsonAtomic(paths.request, {
    schema: 1,
    posVersion: status.available.pos,
    visorVersion: status.available.visor,
    visorExecutable,
    requestedAt: new Date().toISOString(),
  });
  let triggered = true;
  try {
    await execFileAsync('schtasks.exe', ['/Run', '/TN', 'Terrones POS - Actualizar']);
  } catch (_) {
    // La tarea también se ejecuta cada minuto; conservar la solicitud evita
    // perder una actualización por un fallo transitorio de /Run.
    triggered = false;
  }
  return { ok: true, triggered };
}

module.exports = { compareVersions, getStatus, pathsFor, publicKeyFromXml, readVerifiedFeed, requestInstall };
