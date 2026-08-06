const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { resolveStoredLogo, storeKey } = require('../logo-store');

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terrones-logo-'));
  fs.mkdirSync(path.join(root, 'images'));
  return root;
}

test('conserva el logo que ya usa la URL local', (context) => {
  const root = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'images', '127.0.0.1-8080.png');
  fs.writeFileSync(target, png);
  fs.writeFileSync(path.join(root, 'images', 'tunkitos.terrones.png'), Buffer.concat([png, Buffer.from('old')]));

  const result = resolveStoredLogo(root, 'http://127.0.0.1:8080');

  assert.equal(result.path, target);
  assert.equal(result.migratedFrom, null);
  assert.deepEqual(fs.readFileSync(target), png);
});

test('copia automáticamente el logo histórico de Tunkitos', (context) => {
  const root = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacy = path.join(root, 'images', 'tunkitos.terrones.png');
  const expected = path.join(root, 'images', '127.0.0.1-8080.png');
  fs.writeFileSync(legacy, png);
  fs.writeFileSync(path.join(root, 'images', 'pruebas.terrones.png'), Buffer.concat([png, Buffer.from('other')]));

  const result = resolveStoredLogo(root, 'http://127.0.0.1:8080');

  assert.equal(result.path, expected);
  assert.equal(result.migratedFrom, legacy);
  assert.deepEqual(fs.readFileSync(expected), png);
  assert.deepEqual(fs.readFileSync(legacy), png);
});

test('reutiliza el único logo anterior aunque tenga otro nombre', (context) => {
  const root = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacy = path.join(root, 'images', 'otra-tienda.png');
  fs.writeFileSync(legacy, png);

  const result = resolveStoredLogo(root, 'http://localhost:8080');

  assert.equal(result.migratedFrom, legacy);
  assert.equal(path.basename(result.path), 'localhost-8080.png');
});

test('no adivina cuando hay varios logos sin coincidencia conocida', (context) => {
  const root = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'images', 'tienda-a.png'), png);
  fs.writeFileSync(path.join(root, 'images', 'tienda-b.png'), png);

  const result = resolveStoredLogo(root, 'http://127.0.0.1:8080', { preferredKeys: [] });

  assert.equal(result.path, null);
  assert.equal(result.migratedFrom, null);
});

test('genera una clave local estable', () => {
  assert.equal(storeKey('http://127.0.0.1:8080'), '127.0.0.1-8080');
  assert.equal(storeKey('http://localhost:8080'), 'localhost-8080');
});
