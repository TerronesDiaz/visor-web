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
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', '.env.local'), 'STORE_ID=tunkitos\n');
  try { callback(root); } finally {
    if (previous === undefined) delete process.env.TERRONES_POS_HOME;
    else process.env.TERRONES_POS_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('bloquea el POS cuando todavía no existe una copia restaurada', () => {
  withRuntime(() => {
    const result = readProvisioningInfo();
    assert.equal(result.provisioned, false);
    assert.equal(result.recipient, '');
    assert.equal(result.manifest, null);
    assert.equal(result.profile.id, 'tunkitos');
  });
});

test('expone solo la clave pública mientras espera el paquete', () => {
  withRuntime((root) => {
    fs.mkdirSync(path.join(root, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'secrets', 'backup-recipient.txt'), 'age1publica\n');
    const result = readProvisioningInfo();
    assert.equal(result.provisioned, false);
    assert.equal(result.recipient, 'age1publica');
  });
});

test('habilita el POS después de una restauración confirmada', () => {
  withRuntime((root) => {
    const manifest = { version: 1, database: 'tunkitos_pos', createdAt: '2026-08-06T00:00:00Z' };
    fs.mkdirSync(path.join(root, 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, 'state', 'provisioned.json'), JSON.stringify(manifest));
    const result = readProvisioningInfo();
    assert.equal(result.provisioned, true);
    assert.deepEqual(result.manifest, manifest);
  });
});

test('acepta marcadores heredados escritos con BOM por Windows PowerShell 5.1', () => {
  withRuntime((root) => {
    const manifest = { version: 1, database: 'tunkitos_pos', createdAt: '2026-08-07T00:00:00Z' };
    fs.mkdirSync(path.join(root, 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, 'state', 'provisioned.json'), `\uFEFF${JSON.stringify(manifest)}`, 'utf8');
    const result = readProvisioningInfo();
    assert.equal(result.provisioned, true);
    assert.deepEqual(result.manifest, manifest);
  });
});
