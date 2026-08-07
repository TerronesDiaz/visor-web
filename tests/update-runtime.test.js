const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { compareVersions, readVerifiedFeed } = require('../update-runtime');

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
