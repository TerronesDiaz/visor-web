const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const store = require('../profile-store');

function temporaryRuntime(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terrones-profiles-'));
  try { callback(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('registra la instalación heredada como Tunkitos sin mover sus rutas', () => temporaryRuntime((root) => {
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', '.env.local'), 'MYSQL_DATABASE=tunkitos_pos\n');
  const registry = store.ensureRegistry(root);
  assert.equal(registry.profiles.length, 1);
  assert.equal(registry.profiles[0].id, 'tunkitos');
  assert.equal(registry.profiles[0].runtimeRoot, root);
  assert.equal(registry.profiles[0].composeProject, 'terrones-pos-local');
}));

test('aísla un segundo perfil y recuerda el activo', () => temporaryRuntime((root) => {
  store.ensureRegistry(root);
  const papeleria = store.addProfile('papeleria', root);
  assert.equal(papeleria.runtimeRoot, path.join(root, 'profiles', 'papeleria'));
  assert.equal(papeleria.composeProject, 'terrones-pos-papeleria');
  store.setActiveProfile('papeleria', root);
  assert.equal(store.getActiveProfileId(root), 'papeleria');
  assert.equal(fs.existsSync(path.join(papeleria.runtimeRoot, 'backups', 'monthly')), true);
}));

test('rechaza perfiles fuera del catálogo administrado', () => temporaryRuntime((root) => {
  assert.throws(() => store.addProfile('../../otra', root), /no permitido/);
}));

test('rechaza rutas manipuladas en el registro local', () => temporaryRuntime((root) => {
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'profiles.json'), JSON.stringify({
    schema: 1, catalogSchema: 1,
    profiles: [{ ...store.newProfileRecord('papeleria', root), runtimeRoot: path.parse(root).root }],
  }));
  assert.throws(() => store.ensureRegistry(root), /dañado/);
}));

test('acepta el catálogo firmado y rechaza alteraciones', () => temporaryRuntime((root) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const fromUrl = (value) => Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('base64');
  fs.writeFileSync(path.join(root, 'update-public-key.xml'), `<RSAKeyValue><Modulus>${fromUrl(jwk.n)}</Modulus><Exponent>${fromUrl(jwk.e)}</Exponent></RSAKeyValue>`);
  const bytes = Buffer.from(JSON.stringify({ schema: 1, profiles: store.catalog() }));
  fs.writeFileSync(path.join(root, 'store-catalog.json'), bytes);
  fs.writeFileSync(path.join(root, 'store-catalog.json.sig'), crypto.sign('RSA-SHA256', bytes, privateKey).toString('base64'));
  assert.equal(store.initializeCatalog(root, { requireSignature: true }).length, 2);
  fs.appendFileSync(path.join(root, 'store-catalog.json'), ' ');
  assert.throws(() => store.initializeCatalog(root, { requireSignature: true }), /firma/);
}));
