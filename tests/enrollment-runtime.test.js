const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { downloadBundle } = require('../enrollment-runtime');

test('rechaza una descarga cuyo hash fue alterado sin escribirla', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terrones-download-'));
  const target = path.join(root, 'bundle.age');
  const previousFetch = global.fetch;
  global.fetch = async () => new Response(Buffer.from('contenido alterado'), { status: 200 });
  try {
    await assert.rejects(downloadBundle('https://provision.invalid/bundle', 'token', target, '0'.repeat(64)), /SHA-256/);
    assert.equal(fs.existsSync(target), false);
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('una descarga interrumpida no deja un paquete parcial', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terrones-download-'));
  const target = path.join(root, 'bundle.age');
  const previousFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => { throw new Error('conexión interrumpida'); },
  });
  try {
    const expected = crypto.createHash('sha256').update('cualquiera').digest('hex');
    await assert.rejects(downloadBundle('https://provision.invalid/bundle', 'token', target, expected), /interrumpida/);
    assert.equal(fs.existsSync(target), false);
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
