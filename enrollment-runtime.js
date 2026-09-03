const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const profileStore = require('./profile-store');

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 120000, ...options }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); return; }
      resolve({ stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
    });
  });
}

function secret(length = 48) {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join('');
}

function forward(value) { return String(value).replace(/\\/g, '/'); }

function setEnvValue(file, name, value) {
  const safe = String(value).replace(/[\r\n]/g, '');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  const index = lines.findIndex((line) => line.startsWith(`${name}=`));
  if (index >= 0) lines[index] = `${name}=${safe}`; else lines.push(`${name}=${safe}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\r\n')}\r\n`, 'ascii');
}

async function ensureKeys(paths) {
  const ageKeygen = path.join(paths.installRoot, 'tools', 'age-keygen.exe');
  if (!fs.existsSync(ageKeygen)) throw new Error('No se encontró age-keygen.exe en el runtime compartido.');
  fs.mkdirSync(path.dirname(paths.ageIdentity), { recursive: true });
  fs.mkdirSync(path.dirname(paths.sshPrivateKey), { recursive: true });
  if (!fs.existsSync(paths.ageIdentity)) await execFileAsync(ageKeygen, ['-o', paths.ageIdentity]);
  const recipient = (await execFileAsync(ageKeygen, ['-y', paths.ageIdentity])).stdout.trim();
  if (!/^age1[0-9a-z]+$/.test(recipient)) throw new Error('No se pudo derivar la clave pública age.');
  fs.writeFileSync(paths.provisionRecipient, `${recipient}\r\n`, 'ascii');
  if (!fs.existsSync(paths.sshPrivateKey)) {
    const keyDirectory = forward(path.dirname(paths.sshPrivateKey));
    await execFileAsync('docker.exe', ['run', '--rm', '--entrypoint', 'ssh-keygen', '-v', `${keyDirectory}:/keys`, 'terrones-pos-sync-agent:local', '-q', '-t', 'ed25519', '-N', '', '-C', `terrones-${paths.profile.id}`, '-f', '/keys/id_ed25519']);
  }
  const sshPublicKey = fs.readFileSync(`${paths.sshPrivateKey}.pub`, 'utf8').trim();
  if (!/^ssh-ed25519\s+[A-Za-z0-9+/=]+(?:\s+.*)?$/.test(sshPublicKey)) throw new Error('La llave SSH generada no es válida.');
  return { recipient, sshPublicKey };
}

async function initializeProfile(profileId) {
  const profile = profileStore.addProfile(profileId);
  const paths = profileStore.profilePaths(profile.id);
  if (!fs.existsSync(paths.env)) {
    const mysqlRoot = secret();
    const mysqlUser = secret();
    const jwt = secret(64);
    const root = forward(paths.root);
    const values = {
      STORE_ID: profile.id,
      TERRONES_ENV_FILE: `${root}/config/.env.local`, TERRONES_DATA_DIR: `${root}/data`,
      TERRONES_STATE_DIR: `${root}/state`, TERRONES_SECRETS_DIR: `${root}/secrets`,
      TERRONES_BACKUP_DIR: `${root}/backups`, TERRONES_UPDATE_DIR: `${forward(paths.installRoot)}/updates`,
      APP_IMAGE: 'terrones-pos-app:local', SYNC_IMAGE: 'terrones-pos-sync-agent:local', APP_PORT: '8080', APP_MODE: 'local',
      MYSQL_ROOT_PASSWORD: mysqlRoot, MYSQL_DATABASE: 'terrones_pos', MYSQL_USER: 'terrones', MYSQL_PASSWORD: mysqlUser,
      MYSQL_SERVER_ID: profile.localServerId, MYSQL_BUFFER_POOL_SIZE: '256M', HOST: 'db', NOMBRE_BASE_DATOS: 'terrones_pos',
      USER: 'terrones', PASSWORD: mysqlUser, ATLAS_DATABASE_URL: `mysql://terrones:${mysqlUser}@db:3306/terrones_pos`,
      JWT_SECRET: jwt, TOTALES_MODO: 'enforce', SYNC_ENABLED: 'false', SYNC_SSH_HOST: profile.syncHost,
      SYNC_SSH_PORT: profile.syncPort, SYNC_SSH_USER: 'terrones-sync', SYNC_REVERSE_PORT: profile.reversePort,
      SYNC_MEDIA_DEST: '/media/current/', SYNC_BACKUP_DEST: '/backups/', SYNC_INTERVAL_SECONDS: '60',
    };
    for (const [name, value] of Object.entries(values)) setEnvValue(paths.env, name, value);
  }
  const keys = await ensureKeys(paths);
  return { profile, paths, ...keys };
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `El servidor de enrolamiento respondió HTTP ${response.status}.`);
    error.httpStatus = response.status;
    throw error;
  }
  return body;
}

async function pollJob(baseUrl, jobId, jobToken, report) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const result = await requestJson(`${baseUrl}/v1/enrollments/${encodeURIComponent(jobId)}`, {
      headers: { Authorization: `Bearer ${jobToken}` },
    });
    if (result.state === 'ready') return result;
    if (result.state === 'error') {
      const error = new Error(result.error || 'El VPS no pudo preparar la tienda.');
      error.terminalEnrollment = true;
      throw error;
    }
    report({ phase: 'enrollment', state: 'provisioning', message: result.message || 'Preparando copia cifrada en el VPS…' });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('El enrolamiento excedió el tiempo permitido.');
}

async function pollFinalization(baseUrl, jobId, jobToken, report) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const result = await requestJson(`${baseUrl}/v1/enrollments/${encodeURIComponent(jobId)}`, {
      headers: { Authorization: `Bearer ${jobToken}` },
    });
    if (result.state === 'completed') return result;
    if (result.state === 'error') throw new Error(result.error || result.message || 'El VPS no pudo finalizar el corte.');
    report({ phase: 'cutover', state: 'provisioning', message: result.message || 'Configurando la réplica de nube…' });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('La finalización del corte excedió el tiempo permitido.');
}

async function downloadBundle(url, token, target, expectedSha256) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const error = new Error(`No se pudo descargar la copia cifrada (HTTP ${response.status}).`);
    error.httpStatus = response.status;
    throw error;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== String(expectedSha256 || '').toLowerCase()) throw new Error('El SHA-256 de la copia descargada no coincide.');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
}

async function enroll(profileId, code, importBundle, report = () => {}) {
  if (!/^[A-Z0-9-]{8,64}$/i.test(String(code || '').trim())) throw new Error('El código de enrolamiento no es válido.');
  const initialized = await initializeProfile(profileId);
  const baseUrl = initialized.profile.enrollmentUrl.replace(/\/$/, '');
  const attemptFile = path.join(initialized.paths.root, 'secrets', 'enrollment-attempt.json');
  report({ phase: 'enrollment', state: 'provisioning', profileId, message: 'Autorizando esta PC…' });
  let accepted;
  try {
    const stored = JSON.parse(fs.readFileSync(attemptFile, 'utf8').replace(/^\uFEFF/, ''));
    if (stored.schema === 1 && stored.storeId === profileId && /^[a-f0-9]{32}$/.test(stored.jobId || '') && stored.jobToken) accepted = stored;
  } catch (_) {}
  if (!accepted) {
    accepted = await requestJson(`${baseUrl}/v1/enrollments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: String(code).trim(), storeId: profileId, ageRecipient: initialized.recipient, sshPublicKey: initialized.sshPublicKey }),
    });
    profileStore.writeJsonAtomic(attemptFile, {
      schema: 1, storeId: profileId, jobId: accepted.jobId, jobToken: accepted.jobToken,
      enrollmentUrl: baseUrl, createdAt: new Date().toISOString(),
    });
  }
  let ready;
  try { ready = accepted.state === 'ready' ? accepted : await pollJob(baseUrl, accepted.jobId, accepted.jobToken, report); }
  catch (error) {
    if (error.terminalEnrollment || error.httpStatus === 404) fs.rmSync(attemptFile, { force: true });
    throw error;
  }
  if (ready.storeId !== profileId) throw new Error('El VPS devolvió una copia para una tienda diferente.');
  const staging = path.join(initialized.paths.root, 'staging', `enrollment-${ready.jobId}.age`);
  const stagedHash = fs.existsSync(staging) ? crypto.createHash('sha256').update(fs.readFileSync(staging)).digest('hex') : '';
  if (stagedHash !== String(ready.sha256 || '').toLowerCase()) {
    fs.rmSync(staging, { force: true });
    try { await downloadBundle(ready.bundleUrl, ready.jobToken || accepted.jobToken, staging, ready.sha256); }
    catch (error) {
      if (error.httpStatus === 404 || error.httpStatus === 410) fs.rmSync(attemptFile, { force: true });
      throw error;
    }
  }
  setEnvValue(initialized.paths.env, 'MYSQL_DATABASE', ready.database);
  setEnvValue(initialized.paths.env, 'NOMBRE_BASE_DATOS', ready.database);
  setEnvValue(initialized.paths.env, 'ATLAS_DATABASE_URL', `mysql://terrones:${readEnvValue(initialized.paths.env, 'MYSQL_PASSWORD')}@db:3306/${ready.database}`);
  if (ready.knownHosts) {
    if (!String(ready.knownHosts).startsWith(`[${initialized.profile.syncHost}]:${initialized.profile.syncPort} `)) throw new Error('La identidad SSH devuelta no corresponde al perfil.');
    fs.writeFileSync(path.join(initialized.paths.root, 'secrets', 'sync', 'known_hosts'), `${ready.knownHosts}\r\n`, 'ascii');
  }
  if (ready.replicationPassword) fs.writeFileSync(path.join(initialized.paths.root, 'secrets', 'replication-password.txt'), ready.replicationPassword, 'ascii');
  // El perfil se bloquea antes de tocar la base: incluso un reinicio a mitad
  // del proceso no puede abrir ventas sin finalizar el corte en el VPS.
  setEnvValue(initialized.paths.env, 'APP_MODE', 'readonly');
  const result = await importBundle(staging, profileId);
  setEnvValue(initialized.paths.env, 'SYNC_ENABLED', 'true');
  const localRuntime = require('./local-runtime');
  await localRuntime.startBackground(initialized.paths, report);
  profileStore.writeJsonAtomic(path.join(initialized.paths.root, 'secrets', 'enrollment-job.json'), {
    schema: 1, storeId: profileId, jobId: ready.jobId, jobToken: ready.jobToken || accepted.jobToken,
  });
  profileStore.writeJsonAtomic(path.join(initialized.paths.state, 'enrollment.json'), {
    schema: 1, storeId: profileId, jobId: ready.jobId,
    enrollmentUrl: baseUrl, state: 'awaiting_validation', createdAt: new Date().toISOString(),
  });
  fs.rmSync(staging, { force: true });
  fs.rmSync(attemptFile, { force: true });
  return { ...result, profile: initialized.profile, enrollmentId: ready.jobId, awaitingValidation: true };
}

async function finalize(profileId, report = () => {}) {
  const paths = profileStore.profilePaths(profileId);
  const stateFile = path.join(paths.state, 'enrollment.json');
  const secretFile = path.join(paths.root, 'secrets', 'enrollment-job.json');
  const attemptFile = path.join(paths.root, 'secrets', 'enrollment-attempt.json');
  let enrollment;
  let secretState;
  try { enrollment = JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, '')); }
  catch (_) {
    let attempt;
    try { attempt = JSON.parse(fs.readFileSync(attemptFile, 'utf8').replace(/^\uFEFF/, '')); }
    catch (_) { throw new Error('No existe un enrolamiento pendiente para esta tienda.'); }
    if (!fs.existsSync(paths.provisioned)) throw new Error('La copia local aún no terminó de restaurarse.');
    enrollment = { schema: 1, storeId: attempt.storeId, jobId: attempt.jobId, enrollmentUrl: attempt.enrollmentUrl };
    secretState = attempt;
  }
  try { secretState = JSON.parse(fs.readFileSync(secretFile, 'utf8').replace(/^\uFEFF/, '')); }
  catch (_) { secretState = secretState || enrollment; }
  if (enrollment.schema !== 1 || enrollment.storeId !== profileId || !/^[a-f0-9]{32}$/.test(enrollment.jobId || '') ||
      secretState.storeId !== profileId || secretState.jobId !== enrollment.jobId || !secretState.jobToken) {
    throw new Error('El estado local del enrolamiento no es válido.');
  }
  setEnvValue(paths.env, 'APP_MODE', 'readonly');
  setEnvValue(paths.env, 'SYNC_ENABLED', 'true');
  await require('./local-runtime').startBackground(paths, report);
  report({ phase: 'cutover', state: 'provisioning', profileId, message: 'Conectando y verificando la réplica de nube…' });
  await requestJson(`${enrollment.enrollmentUrl}/v1/enrollments/${encodeURIComponent(enrollment.jobId)}/finalize`, {
    method: 'POST', headers: { Authorization: `Bearer ${secretState.jobToken}` },
  });
  await pollFinalization(enrollment.enrollmentUrl, enrollment.jobId, secretState.jobToken, report);
  setEnvValue(paths.env, 'APP_MODE', 'local');
  fs.rmSync(stateFile, { force: true });
  fs.rmSync(secretFile, { force: true });
  fs.rmSync(attemptFile, { force: true });
  return { ok: true, profile: paths.profile, cutoverComplete: true };
}

function readEnvValue(file, name) {
  const match = fs.readFileSync(file, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'));
  return match ? match[1].trim() : '';
}

module.exports = { downloadBundle, enroll, ensureKeys, finalize, initializeProfile, readEnvValue, setEnvValue };
