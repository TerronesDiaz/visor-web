const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { INSTALL_PHASES, compareVersions, getStatus, preflight, readVerifiedFeed } = require('../update-runtime');

test('compara versiones de cuatro segmentos', () => {
  assert.equal(compareVersions('2026.08.07.2', '2026.08.07.1'), 1);
  assert.equal(compareVersions('2.2.0', '2.2.0'), 0);
  assert.equal(compareVersions('2.1.9', '2.2.0'), -1);
});

test('acepta un feed firmado y rechaza alteraciones', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terrones-update-'));
  const directory = path.join(root, 'updates', 'downloads', 'pos', 'current');
  fs.mkdirSync(directory, { recursive: true });
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const fromUrl = (value) => Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('base64');
  const xml = `<RSAKeyValue><Modulus>${fromUrl(jwk.n)}</Modulus><Exponent>${fromUrl(jwk.e)}</Exponent></RSAKeyValue>`;
  const keyFile = path.join(root, 'public.xml');
  fs.writeFileSync(keyFile, xml);
  const packageName = 'TerronesPOS-test.zip';
  const packageBytes = Buffer.from('contenido verificado');
  fs.writeFileSync(path.join(directory, packageName), packageBytes);
  const manifest = Buffer.from(JSON.stringify({ schema: 1, channel: 'pos', version: '1.0.0', package: { name: packageName, size: packageBytes.length, sha256: crypto.createHash('sha256').update(packageBytes).digest('hex') } }));
  fs.writeFileSync(path.join(directory, 'latest.json'), manifest);
  fs.writeFileSync(path.join(directory, 'latest.json.sig'), crypto.sign('RSA-SHA256', manifest, privateKey).toString('base64'));
  fs.writeFileSync(path.join(directory, '.verified.json'), JSON.stringify({ channel: 'pos', sha256: crypto.createHash('sha256').update(packageBytes).digest('hex') }));
  assert.equal(readVerifiedFeed('pos', root, keyFile).ok, true);
  fs.appendFileSync(path.join(directory, 'latest.json'), ' ');
  assert.equal(readVerifiedFeed('pos', root, keyFile).ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('mantiene visible un error anterior aunque el paquete siga listo para reintentar', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terrones-update-error-'));
  const directory = path.join(root, 'updates', 'downloads', 'pos', 'current');
  fs.mkdirSync(directory, { recursive: true });
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const fromUrl = (value) => Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('base64');
  fs.writeFileSync(path.join(root, 'public.xml'), `<RSAKeyValue><Modulus>${fromUrl(jwk.n)}</Modulus><Exponent>${fromUrl(jwk.e)}</Exponent></RSAKeyValue>`);
  const packageName = 'TerronesPOS-error.zip';
  const packageBytes = Buffer.from('paquete para reintento');
  const sha256 = crypto.createHash('sha256').update(packageBytes).digest('hex');
  const manifest = Buffer.from(JSON.stringify({ schema: 1, channel: 'pos', version: '2026.08.07.2', notes: 'Corrección', package: { name: packageName, size: packageBytes.length, sha256 } }));
  fs.writeFileSync(path.join(directory, packageName), packageBytes);
  fs.writeFileSync(path.join(directory, 'latest.json'), manifest);
  fs.writeFileSync(path.join(directory, 'latest.json.sig'), crypto.sign('RSA-SHA256', manifest, privateKey).toString('base64'));
  fs.writeFileSync(path.join(directory, '.verified.json'), JSON.stringify({ channel: 'pos', sha256 }));
  fs.writeFileSync(path.join(root, 'updates', 'current.json'), JSON.stringify({ version: '2026.08.07.1' }));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'update-status.json'), JSON.stringify({ state: 'error', message: 'Falló la instalación.', error: 'Detalle comprobable.' }));

  try {
    const status = getStatus('2.2.0', root, path.join(root, 'public.xml'));
    assert.equal(status.state, 'error');
    assert.equal(status.canInstall, true);
    assert.match(status.message, /Detalle comprobable/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeSignedPosFeed(root, { version = '2026.10.30.2' } = {}) {
  const directory = path.join(root, 'updates', 'downloads', 'pos', 'current');
  fs.mkdirSync(directory, { recursive: true });
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const fromUrl = (value) => Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('base64');
  const keyFile = path.join(root, 'public.xml');
  fs.writeFileSync(keyFile, `<RSAKeyValue><Modulus>${fromUrl(jwk.n)}</Modulus><Exponent>${fromUrl(jwk.e)}</Exponent></RSAKeyValue>`);
  const packageName = 'TerronesPOS-flow.zip';
  const packageBytes = Buffer.from('paquete de prueba del flujo');
  const sha256 = crypto.createHash('sha256').update(packageBytes).digest('hex');
  const manifest = Buffer.from(JSON.stringify({ schema: 1, channel: 'pos', version, package: { name: packageName, size: packageBytes.length, sha256 } }));
  fs.writeFileSync(path.join(directory, packageName), packageBytes);
  fs.writeFileSync(path.join(directory, 'latest.json'), manifest);
  fs.writeFileSync(path.join(directory, 'latest.json.sig'), crypto.sign('RSA-SHA256', manifest, privateKey).toString('base64'));
  fs.writeFileSync(path.join(directory, '.verified.json'), JSON.stringify({ channel: 'pos', sha256 }));
  fs.writeFileSync(path.join(root, 'updates', 'current.json'), JSON.stringify({ version: '2026.10.30.1' }));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  return keyFile;
}

test('registra cada intento terminado una sola vez y conserva su registro', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terrones-update-history-'));
  try {
    const keyFile = writeSignedPosFeed(root);
    const log = path.join(root, 'logs', 'update-1.log');
    fs.writeFileSync(path.join(root, 'state', 'update-progress.json'), JSON.stringify({ phase: 'failed', version: '2026.10.30.2', log, updatedAt: '2026-10-30T05:12:46Z' }));
    fs.writeFileSync(path.join(root, 'state', 'update-status.json'), JSON.stringify({ state: 'error', message: 'No se completó.', error: 'MySQL local no está iniciado.', version: '', updatedAt: '2026-10-30T05:12:46Z' }));
    getStatus('3.0.3', root, keyFile);
    const status = getStatus('3.0.3', root, keyFile);
    const history = JSON.parse(fs.readFileSync(path.join(root, 'state', 'update-history.json'), 'utf8'));
    assert.equal(history.attempts.length, 1);
    assert.equal(status.lastAttempt.version, '2026.10.30.2');
    assert.equal(status.lastAttempt.log, log);
    assert.match(status.lastAttempt.error, /MySQL/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('muestra la fase de instalación y libera una instalación abandonada', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terrones-update-phase-'));
  try {
    const keyFile = writeSignedPosFeed(root);
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(root, 'state', 'update-status.json'), JSON.stringify({ state: 'installing', message: 'Instalando…', updatedAt: now }));
    fs.writeFileSync(path.join(root, 'state', 'update-progress.json'), JSON.stringify({ phase: 'migrate', message: 'Actualizando la base de datos…', updatedAt: now }));
    const installing = getStatus('3.0.3', root, keyFile);
    assert.equal(installing.state, 'installing');
    assert.equal(installing.install.phase, 'migrate');
    assert.equal(installing.canInstall, false);

    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(root, 'state', 'update-status.json'), JSON.stringify({ state: 'installing', message: 'Instalando…', updatedAt: old }));
    const abandoned = getStatus('3.0.3', root, keyFile);
    assert.equal(abandoned.state, 'error');
    assert.equal(abandoned.canInstall, true);
    assert.match(abandoned.message, /interrumpió/);

    fs.mkdirSync(path.join(root, 'updates'), { recursive: true });
    fs.writeFileSync(path.join(root, 'updates', 'install.lock'), '');
    assert.equal(getStatus('3.0.3', root, keyFile).state, 'installing', 'An updater holding its lock is still running');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('la revisión previa rechaza disco lleno, base detenida y actualizaciones en curso sin cerrar el POS', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terrones-update-preflight-'));
  try {
    const keyFile = writeSignedPosFeed(root);
    const check = await preflight({
      visorVersion: '3.0.3', root, publicKeyFile: keyFile, free: 10,
      checkDatabase: async () => { throw new Error('La base de datos local no está iniciada.'); },
    });
    assert.equal(check.ok, false);
    assert.ok(check.problems.some((problem) => /Espacio insuficiente/.test(problem)), check.problems.join(' | '));
    assert.ok(check.problems.some((problem) => /base de datos local/.test(problem)), check.problems.join(' | '));

    fs.writeFileSync(path.join(root, 'updates', 'request.json'), '{}');
    const busy = await preflight({ visorVersion: '3.0.3', root, publicKeyFile: keyFile, free: 1024 ** 4 });
    assert.ok(busy.problems.some((problem) => /en curso/.test(problem)), busy.problems.join(' | '));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('la ventana de progreso se empaqueta con BOM y usa las mismas fases', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'Show-UpdateProgress.ps1'));
  assert.deepEqual([...script.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'Windows PowerShell 5.1 needs a BOM to read the accents');
  const text = script.toString('utf8');
  const status = fs.readFileSync(path.join(__dirname, '..', 'vistas', 'status.js'), 'utf8');
  for (const phase of INSTALL_PHASES.filter((id) => !['visor', 'done', 'failed'].includes(id))) {
    assert.ok(text.includes(`Id = '${phase}'`), `Show-UpdateProgress.ps1 is missing ${phase}`);
    assert.ok(status.includes(`['${phase}',`), `status.js is missing ${phase}`);
  }
  const build = require('../package.json').build;
  assert.ok(build.extraResources.some((entry) => entry.from === 'scripts/Show-UpdateProgress.ps1' && entry.to === 'update/Show-UpdateProgress.ps1'));
});
