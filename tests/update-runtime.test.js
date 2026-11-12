const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');
const {
  AUTO_IDLE_SECONDS, AUTO_MAX_ATTEMPTS, INSTALL_PHASES, autoInstallDecision, compareVersions, getStatus, hasNewMigrations,
  installMode, preflight, readVerifiedFeed, recordAutoAttempt, updateActivity, updaterFeatures,
} = require('../update-runtime');

// Holds the lock the way Invoke-TerronesUpdate.ps1 does: open, without sharing.
async function holdLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const holder = spawn('powershell.exe', ['-NoProfile', '-Command',
    `$f=[IO.File]::Open('${file.replace(/'/g, "''")}','OpenOrCreate','ReadWrite','None'); [Console]::In.ReadLine() | Out-Null; $f.Dispose()`]);
  const deadline = Date.now() + 15000;
  for (;;) {
    try { fs.closeSync(fs.openSync(file, 'r')); } catch (error) { if (error.code === 'EBUSY') break; }
    if (Date.now() > deadline) { holder.kill(); throw new Error('PowerShell did not take the lock.'); }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return () => new Promise((resolve) => { holder.on('exit', resolve); holder.stdin.end('\n'); });
}

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

function writeSignedPosFeed(root, { version = '2026.10.30.2', extra = {}, current = { version: '2026.10.30.1' } } = {}) {
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
  const manifest = Buffer.from(JSON.stringify({ schema: 1, channel: 'pos', version, ...extra, package: { name: packageName, size: packageBytes.length, sha256 } }));
  fs.writeFileSync(path.join(directory, packageName), packageBytes);
  fs.writeFileSync(path.join(directory, 'latest.json'), manifest);
  fs.writeFileSync(path.join(directory, 'latest.json.sig'), crypto.sign('RSA-SHA256', manifest, privateKey).toString('base64'));
  fs.writeFileSync(path.join(directory, '.verified.json'), JSON.stringify({ channel: 'pos', sha256 }));
  fs.writeFileSync(path.join(root, 'updates', 'current.json'), JSON.stringify(current));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  return keyFile;
}

function withRoot(prefix, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return Promise.resolve().then(() => run(root)).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}

function writeUpdaterFeatures(root, features) {
  fs.mkdirSync(path.join(root, 'updater'), { recursive: true });
  fs.writeFileSync(path.join(root, 'updater', 'capabilities.json'), JSON.stringify({ schema: 1, features }));
}

test('una versión es automática solo si su manifiesto firmado lo dice', () => withRoot('terrones-update-mode-', (root) => {
  let keyFile = writeSignedPosFeed(root);
  let status = getStatus('3.3.0', root, keyFile);
  assert.equal(status.mode, 'manual', 'A manifest signed before the field existed waits for the button');
  assert.equal(installMode({ install: { mode: 'siempre' } }), 'manual');

  keyFile = writeSignedPosFeed(root, { extra: { install: { mode: 'auto' } } });
  status = getStatus('3.3.0', root, keyFile);
  assert.equal(status.mode, 'auto');
  assert.equal(status.key, '2026.10.30.2|');
  assert.equal(status.auto.blocked, null);

  // Nothing pending: there is no mode to show.
  keyFile = writeSignedPosFeed(root, { version: '2026.10.30.1', extra: { install: { mode: 'auto' } } });
  status = getStatus('3.3.0', root, keyFile);
  assert.equal(status.mode, null);
  assert.equal(status.canInstall, false);
}));

test('una versión es ligera solo sin migraciones nuevas y con un actualizador que lo soporte', () => withRoot('terrones-update-light-', (root) => {
  const applied = ['20260101000000_inicial', '20260202000000_segunda'];
  const current = { version: '2026.10.30.1', requiredMigrations: applied };
  let keyFile = writeSignedPosFeed(root, { extra: { requiredMigrations: applied }, current });
  assert.equal(getStatus('3.3.0', root, keyFile).light, false, 'An updater that cannot do it stops the POS as before');

  writeUpdaterFeatures(root, ['visor-abierto', 'recuperacion', 'ligera']);
  assert.equal(getStatus('3.3.0', root, keyFile).light, true);

  keyFile = writeSignedPosFeed(root, { extra: { requiredMigrations: [...applied, '20260303000000_nueva'] }, current });
  assert.equal(getStatus('3.3.0', root, keyFile).light, false, 'A new migration needs the backup');

  // Same conservative answers as Test-LightUpdate in the updater.
  assert.equal(hasNewMigrations({ requiredMigrations: applied }, { version: '1', requiredMigrations: applied }), false);
  assert.equal(hasNewMigrations({ requiredMigrations: applied }, { version: '1' }), true, 'A box without a recorded list is unknown');
  assert.equal(hasNewMigrations({}, { version: '1', requiredMigrations: applied }), true, 'A manifest without a list is unknown');
  assert.equal(hasNewMigrations({ requiredMigrations: [] }, { version: '1', requiredMigrations: applied }), true);
  assert.equal(hasNewMigrations({ requiredMigrations: applied }, { requiredMigrations: applied }), true, 'No installed version on record');
}));

test('una versión automática se instala sola al abrir o con la caja sin uso, y no insiste', () => withRoot('terrones-update-auto-', (root) => {
  const keyFile = writeSignedPosFeed(root, { extra: { install: { mode: 'auto' } } });
  const status = getStatus('3.3.0', root, keyFile);
  assert.deepEqual(autoInstallDecision(status, { atStartup: true }), { install: true, reason: 'startup' });
  assert.equal(autoInstallDecision(status, { idleSeconds: AUTO_IDLE_SECONDS - 1 }).reason, 'in-use');
  assert.equal(autoInstallDecision(status, {}).install, false, 'Unknown idle time is not idle');
  assert.deepEqual(autoInstallDecision(status, { idleSeconds: AUTO_IDLE_SECONDS }), { install: true, reason: 'idle' });
  assert.equal(autoInstallDecision(status, { idleSeconds: 9999, snoozedKey: status.key }).reason, 'snoozed');
  assert.equal(autoInstallDecision(status, { atStartup: true, snoozedKey: 'otra|' }).install, true, 'Postponing one release does not postpone the next');

  const manual = getStatus('3.3.0', root, writeSignedPosFeed(root));
  assert.equal(autoInstallDecision(manual, { atStartup: true }).reason, 'manual');
  assert.equal(autoInstallDecision({ canInstall: false }, { atStartup: true }).reason, 'nothing');
}));

test('una versión automática que ya falló o se intentó dos veces espera a una persona', () => withRoot('terrones-update-auto-block-', (root) => {
  const keyFile = writeSignedPosFeed(root, { extra: { install: { mode: 'auto' } } });
  const key = getStatus('3.3.0', root, keyFile).key;
  assert.equal(recordAutoAttempt(key, root), 1);
  assert.equal(getStatus('3.3.0', root, keyFile).auto.blocked, null);
  assert.equal(recordAutoAttempt(key, root), AUTO_MAX_ATTEMPTS);
  let status = getStatus('3.3.0', root, keyFile);
  assert.equal(status.auto.blocked, 'attempts');
  assert.equal(autoInstallDecision(status, { atStartup: true }).reason, 'attempts');
  // Attempts are counted per release.
  assert.equal(recordAutoAttempt('2026.12.01.1|', root), 1);
  assert.equal(getStatus('3.3.0', root, keyFile).auto.blocked, null);

  fs.writeFileSync(path.join(root, 'state', 'update-progress.json'), JSON.stringify({ phase: 'failed', version: '2026.10.30.2', updatedAt: '2026-11-11T05:00:00Z' }));
  fs.writeFileSync(path.join(root, 'state', 'update-status.json'), JSON.stringify({ state: 'error', message: 'No se completó.', error: 'Detalle.', version: '', updatedAt: '2026-11-11T05:00:00Z' }));
  status = getStatus('3.3.0', root, keyFile);
  assert.equal(status.auto.blocked, 'failed');
  assert.equal(status.canInstall, true, 'It can still be installed with the button');
  assert.equal(autoInstallDecision(status, { atStartup: true }).install, false);
}));

test('el visor sabe si la actualización en curso es ligera solo cuando el actualizador lo dice', () => withRoot('terrones-update-light-activity-', (root) => {
  fs.mkdirSync(path.join(root, 'updates'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  const requestedAt = new Date().toISOString();
  fs.writeFileSync(path.join(root, 'updates', 'request.json'), JSON.stringify({ posVersion: '2026.11.12.1', visorOpen: true, requestedAt }));
  assert.equal(updateActivity(root).light, null, 'Nothing reported yet');

  const write = (status) => fs.writeFileSync(path.join(root, 'state', 'update-status.json'), JSON.stringify(status));
  write({ state: 'installing', light: null, updatedAt: new Date().toISOString() });
  assert.equal(updateActivity(root).light, null, 'The updater has not looked at the manifest yet');
  write({ state: 'installing', light: true, updatedAt: new Date().toISOString() });
  assert.equal(updateActivity(root).light, true);
  write({ state: 'installing', light: false, updatedAt: new Date().toISOString() });
  assert.equal(updateActivity(root).light, false);
  // What an earlier attempt left behind says nothing about this request.
  write({ state: 'installing', light: true, updatedAt: '2026-10-01T00:00:00Z' });
  assert.equal(updateActivity(root).light, null);
}));

test('las notas del visor indican el modo con una línea propia', () => {
  const { installModeFromNotes } = require('../scripts/Sign-TerronesUpdateFeed');
  assert.equal(installModeFromNotes('# visor-web 3.3.0\n\nPrimer párrafo.\n'), 'manual');
  assert.equal(installModeFromNotes('# visor-web 3.3.0\r\n\r\nPrimer párrafo.\r\n\r\nInstalación: automática\r\n'), 'auto');
  assert.throws(() => installModeFromNotes('Instalación: siempre'), /desconocido/);
  for (const file of fs.readdirSync(path.join(__dirname, '..', 'docs', 'releases'))) {
    assert.doesNotThrow(() => installModeFromNotes(fs.readFileSync(path.join(__dirname, '..', 'docs', 'releases', file), 'utf8')), file);
  }
});

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

test('muestra la fase de instalación y libera una instalación abandonada', async () => {
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

    // A restart leaves the file behind; nobody holds it, so it does not count as running.
    fs.writeFileSync(path.join(root, 'updates', 'install.lock'), '');
    assert.equal(getStatus('3.0.3', root, keyFile).state, 'error', 'A leftover lock file must not keep the box installing');
    const release = await holdLock(path.join(root, 'updates', 'install.lock'));
    try {
      assert.equal(getStatus('3.0.3', root, keyFile).state, 'installing', 'An updater holding its lock is still running');
    } finally { await release(); }
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

test('detecta una actualización en curso aunque el visor se vuelva a abrir', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terrones-update-activity-'));
  try {
    assert.equal(updateActivity(root).active, false);
    fs.mkdirSync(path.join(root, 'updates'), { recursive: true });
    fs.mkdirSync(path.join(root, 'state'), { recursive: true });
    const requestedAt = new Date().toISOString();
    fs.writeFileSync(path.join(root, 'updates', 'request.json'), JSON.stringify({ posVersion: '2026.11.02.1', visorOpen: true, requestedAt }));
    // An earlier attempt's progress must not be read as this one's.
    fs.writeFileSync(path.join(root, 'state', 'update-progress.json'), JSON.stringify({ phase: 'visor', updatedAt: '2026-10-01T00:00:00Z' }));
    const pending = updateActivity(root);
    assert.equal(pending.active, true, 'A request the updater has not claimed yet is still an update');
    assert.equal(pending.progress, null);
    assert.equal(pending.request.visorOpen, true);

    const release = await holdLock(path.join(root, 'updates', 'install.lock'));
    try {
      fs.writeFileSync(path.join(root, 'state', 'update-progress.json'), JSON.stringify({ phase: 'migrate', message: 'Actualizando…', updatedAt: new Date().toISOString() }));
      const running = updateActivity(root, Date.now() + 60 * 60 * 1000);
      assert.equal(running.active, true, 'A held lock is running however long it takes');
      assert.equal(running.progress.phase, 'migrate');
    } finally { await release(); }

    // A request nobody claimed (old updater stuck on a leftover lock) must not block the box.
    const abandoned = updateActivity(root, Date.now() + 10 * 60 * 1000);
    assert.equal(abandoned.active, false);
    assert.equal(abandoned.stale, true);
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(path.join(root, 'updates', 'request.json'), tenMinutesAgo, tenMinutesAgo);
    fs.writeFileSync(path.join(root, 'state', 'update-progress.json'), JSON.stringify({ phase: 'migrate', updatedAt: tenMinutesAgo.toISOString() }));
    const check = await preflight({ visorVersion: '3.2.0', root, free: 1024 ** 4 });
    assert.ok(check.problems.some((problem) => /quedó sin terminar/.test(problem)), check.problems.join(' | '));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lee las capacidades del actualizador instalado', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terrones-update-features-'));
  try {
    assert.deepEqual(updaterFeatures(root), [], 'An updater without capabilities.json closes the visor first');
    fs.mkdirSync(path.join(root, 'updater'), { recursive: true });
    fs.writeFileSync(path.join(root, 'updater', 'capabilities.json'), JSON.stringify({ schema: 1, features: ['visor-abierto', 'recuperacion'] }));
    assert.ok(updaterFeatures(root).includes('visor-abierto'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
