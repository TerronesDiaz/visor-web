const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readProvisioningInfo } = require('../local-runtime');

function withRuntime(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terrones-runtime-'));
  const previous = process.env.TERRONES_POS_HOME;
  process.env.TERRONES_POS_HOME = root;
  try { callback(root); } finally {
    if (previous === undefined) delete process.env.TERRONES_POS_HOME;
    else process.env.TERRONES_POS_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('bloquea el POS cuando todavía no existe una copia restaurada', () => {
  withRuntime(() => {
    assert.deepEqual(readProvisioningInfo(), { provisioned: false, recipient: '', manifest: null });
  });
});

test('expone solo la clave pública mientras espera el paquete', () => {
  withRuntime((root) => {
    fs.mkdirSync(path.join(root, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'secrets', 'backup-recipient.txt'), 'age1publica\n');
    assert.deepEqual(readProvisioningInfo(), { provisioned: false, recipient: 'age1publica', manifest: null });
  });
});

test('habilita el POS después de una restauración confirmada', () => {
  withRuntime((root) => {
    const manifest = { version: 1, database: 'tunkitos_pos', createdAt: '2026-08-06T00:00:00Z' };
    fs.mkdirSync(path.join(root, 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, 'state', 'provisioned.json'), JSON.stringify(manifest));
    assert.deepEqual(readProvisioningInfo(), { provisioned: true, recipient: '', manifest });
  });
});

test('acepta marcadores heredados escritos con BOM por Windows PowerShell 5.1', () => {
  withRuntime((root) => {
    const manifest = { version: 1, database: 'tunkitos_pos', createdAt: '2026-08-07T00:00:00Z' };
    fs.mkdirSync(path.join(root, 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, 'state', 'provisioned.json'), `\uFEFF${JSON.stringify(manifest)}`, 'utf8');
    assert.deepEqual(readProvisioningInfo(), { provisioned: true, recipient: '', manifest });
  });
});
