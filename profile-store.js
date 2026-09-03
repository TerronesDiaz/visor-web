const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CATALOG_SCHEMA = 1;
const REGISTRY_SCHEMA = 1;
const BUILTIN_CATALOG = Object.freeze([
  Object.freeze({
    id: 'tunkitos',
    displayName: 'Tunkitos',
    cloudUrl: 'https://tunkitos.terrones.dev',
    enrollmentUrl: 'https://provision.terrones.dev',
    syncHost: 'sync.terrones.dev',
    syncPort: 2222,
    reversePort: 13306,
    localServerId: 101,
    cloudServerId: 201,
  }),
  Object.freeze({
    id: 'papeleria',
    displayName: 'Papelería',
    cloudUrl: 'https://papeleria.terrones.dev',
    enrollmentUrl: 'https://provision.terrones.dev',
    syncHost: 'sync.terrones.dev',
    syncPort: 2223,
    reversePort: 13306,
    localServerId: 102,
    cloudServerId: 202,
  }),
]);
let STORE_CATALOG = BUILTIN_CATALOG;

function runtimeRoot() {
  return process.env.TERRONES_POS_HOME || path.join(process.env.ProgramData || 'C:\\ProgramData', 'TerronesPOS');
}

function registryPaths(root = runtimeRoot()) {
  return {
    registry: path.join(root, 'config', 'profiles.json'),
    active: path.join(root, 'state', 'active-profile.json'),
  };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return fallback; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, file);
}

function catalog() {
  return STORE_CATALOG.map((profile) => ({ ...profile }));
}

function validateCatalog(value) {
  if (!value || value.schema !== CATALOG_SCHEMA || !Array.isArray(value.profiles) || value.profiles.length < 1) return false;
  const ids = new Set();
  for (const profile of value.profiles) {
    if (!profile || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(profile.id || '') || ids.has(profile.id)) return false;
    if (!/^https:\/\/[a-z0-9.-]+$/i.test(profile.cloudUrl || '') || !/^https:\/\/[a-z0-9.-]+$/i.test(profile.enrollmentUrl || '')) return false;
    if (!/^[a-z0-9.-]+$/i.test(profile.syncHost || '') || !Number.isInteger(profile.syncPort) || !Number.isInteger(profile.reversePort) || !Number.isInteger(profile.localServerId) || !Number.isInteger(profile.cloudServerId)) return false;
    if (profile.syncPort < 1 || profile.syncPort > 65535 || profile.reversePort < 1024 || profile.reversePort > 65535) return false;
    ids.add(profile.id);
  }
  return true;
}

function initializeCatalog(baseDirectory, options = {}) {
  const catalogFile = path.join(baseDirectory, 'store-catalog.json');
  const signatureFile = `${catalogFile}.sig`;
  const publicKeyFile = path.join(baseDirectory, 'update-public-key.xml');
  if (!fs.existsSync(catalogFile) || !fs.existsSync(signatureFile)) {
    if (options.requireSignature) throw new Error('El catálogo firmado de tiendas no está incluido.');
    STORE_CATALOG = BUILTIN_CATALOG;
    return catalog();
  }
  const bytes = fs.readFileSync(catalogFile);
  const signature = Buffer.from(fs.readFileSync(signatureFile, 'utf8').trim(), 'base64');
  const { publicKeyFromXml } = require('./update-runtime');
  const publicKey = publicKeyFromXml(fs.readFileSync(publicKeyFile, 'utf8'));
  if (!crypto.verify('RSA-SHA256', bytes, publicKey, signature)) throw new Error('La firma del catálogo de tiendas no es válida.');
  const parsed = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (!validateCatalog(parsed)) throw new Error('El catálogo de tiendas no es compatible.');
  STORE_CATALOG = Object.freeze(parsed.profiles.map((profile) => Object.freeze({ ...profile })));
  return catalog();
}

function catalogProfile(profileId) {
  const id = String(profileId || '').toLowerCase();
  const profile = STORE_CATALOG.find((entry) => entry.id === id);
  if (!profile) throw new Error(`Perfil de tienda no permitido: ${profileId}`);
  return { ...profile };
}

function newProfileRecord(profileId, root = runtimeRoot(), options = {}) {
  const definition = catalogProfile(profileId);
  const legacy = Boolean(options.legacy);
  return {
    ...definition,
    runtimeRoot: legacy ? root : path.join(root, 'profiles', definition.id),
    composeProject: legacy ? 'terrones-pos-local' : `terrones-pos-${definition.id}`,
    legacy,
    createdAt: new Date().toISOString(),
  };
}

function validateRegistry(value, root = runtimeRoot()) {
  if (!value || value.schema !== REGISTRY_SCHEMA || !Array.isArray(value.profiles)) return false;
  const ids = new Set();
  for (const profile of value.profiles) {
    if (!profile || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(profile.id || '') || ids.has(profile.id)) return false;
    catalogProfile(profile.id);
    const legacy = profile.id === 'tunkitos' && profile.legacy === true;
    const expectedRoot = legacy ? root : path.join(root, 'profiles', profile.id);
    const expectedProject = legacy ? 'terrones-pos-local' : `terrones-pos-${profile.id}`;
    if (path.resolve(profile.runtimeRoot || '') !== path.resolve(expectedRoot) || profile.composeProject !== expectedProject) return false;
    ids.add(profile.id);
  }
  return true;
}

function ensureRegistry(root = runtimeRoot()) {
  const files = registryPaths(root);
  let registry = readJson(files.registry, null);
  if (registry && !validateRegistry(registry, root)) throw new Error('El registro local de perfiles está dañado o contiene una tienda no autorizada.');
  if (!registry) {
    const hasLegacy = fs.existsSync(path.join(root, 'config', '.env.local')) || fs.existsSync(path.join(root, 'state', 'provisioned.json'));
    registry = {
      schema: REGISTRY_SCHEMA,
      catalogSchema: CATALOG_SCHEMA,
      profiles: hasLegacy ? [newProfileRecord('tunkitos', root, { legacy: true })] : [],
    };
    writeJsonAtomic(files.registry, registry);
  } else {
    registry.profiles = registry.profiles.map((stored) => ({
      ...stored,
      ...catalogProfile(stored.id),
      runtimeRoot: stored.runtimeRoot,
      composeProject: stored.composeProject,
      legacy: stored.legacy === true,
    }));
  }
  let active = readJson(files.active, null)?.profileId;
  if (!registry.profiles.some((profile) => profile.id === active)) active = registry.profiles[0]?.id || null;
  if (active) writeJsonAtomic(files.active, { schema: 1, profileId: active, updatedAt: new Date().toISOString() });
  return registry;
}

function listProfiles(root = runtimeRoot()) {
  return ensureRegistry(root).profiles.map((profile) => ({ ...profile }));
}

function getProfile(profileId, root = runtimeRoot()) {
  const id = profileId || getActiveProfileId(root);
  const profile = listProfiles(root).find((entry) => entry.id === id);
  if (!profile) throw new Error(id ? `El perfil ${id} no está instalado.` : 'No hay una tienda configurada.');
  return profile;
}

function getActiveProfileId(root = runtimeRoot()) {
  const profiles = ensureRegistry(root).profiles;
  const active = readJson(registryPaths(root).active, null)?.profileId;
  return profiles.some((profile) => profile.id === active) ? active : (profiles[0]?.id || null);
}

function setActiveProfile(profileId, root = runtimeRoot()) {
  const profile = getProfile(profileId, root);
  writeJsonAtomic(registryPaths(root).active, { schema: 1, profileId: profile.id, updatedAt: new Date().toISOString() });
  return profile;
}

function addProfile(profileId, root = runtimeRoot()) {
  const registry = ensureRegistry(root);
  const existing = registry.profiles.find((profile) => profile.id === profileId);
  if (existing) return { ...existing };
  const profile = newProfileRecord(profileId, root);
  for (const relative of ['config', 'data/img', 'state', 'secrets/sync', 'backups/daily', 'backups/weekly', 'backups/monthly']) {
    fs.mkdirSync(path.join(profile.runtimeRoot, relative), { recursive: true });
  }
  registry.profiles.push(profile);
  writeJsonAtomic(registryPaths(root).registry, registry);
  if (!getActiveProfileId(root)) setActiveProfile(profile.id, root);
  return { ...profile };
}

function profilePaths(profileId, root = runtimeRoot()) {
  const profile = getProfile(profileId, root);
  const profileRoot = profile.runtimeRoot;
  return {
    profile,
    installRoot: root,
    root: profileRoot,
    app: path.join(root, 'app'),
    compose: path.join(root, 'app', 'docker-compose.local.yml'),
    env: path.join(profileRoot, 'config', '.env.local'),
    state: path.join(profileRoot, 'state'),
    syncStatus: path.join(profileRoot, 'state', 'sync-status.json'),
    provisioned: path.join(profileRoot, 'state', 'provisioned.json'),
    provisionRecipient: path.join(profileRoot, 'secrets', 'backup-recipient.txt'),
    ageIdentity: path.join(profileRoot, 'secrets', 'age-identity.txt'),
    sshPrivateKey: path.join(profileRoot, 'secrets', 'sync', 'id_ed25519'),
    provisionImporter: path.join(root, 'app', 'deploy', 'local', 'Import-TerronesProvision.ps1'),
    backupScript: path.join(root, 'app', 'deploy', 'local', 'New-TerronesBackup.ps1'),
  };
}

module.exports = {
  CATALOG_SCHEMA,
  REGISTRY_SCHEMA,
  addProfile,
  catalog,
  catalogProfile,
  ensureRegistry,
  getActiveProfileId,
  getProfile,
  listProfiles,
  initializeCatalog,
  newProfileRecord,
  profilePaths,
  registryPaths,
  runtimeRoot,
  setActiveProfile,
  validateRegistry,
  validateCatalog,
  writeJsonAtomic,
};
