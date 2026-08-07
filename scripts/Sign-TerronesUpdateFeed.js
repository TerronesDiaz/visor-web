const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function value(xml, name) {
  const match = xml.match(new RegExp(`<${name}>([^<]+)</${name}>`));
  if (!match) throw new Error(`La clave privada no contiene ${name}.`);
  return match[1].replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function privateKey(xml) {
  return crypto.createPrivateKey({ key: {
    kty: 'RSA', n: value(xml, 'Modulus'), e: value(xml, 'Exponent'), d: value(xml, 'D'), p: value(xml, 'P'),
    q: value(xml, 'Q'), dp: value(xml, 'DP'), dq: value(xml, 'DQ'), qi: value(xml, 'InverseQ'),
  }, format: 'jwk' });
}

const [packagePath, outputDirectory, notes = ''] = process.argv.slice(2);
if (!packagePath || !outputDirectory) throw new Error('Uso: node Sign-TerronesUpdateFeed.js instalador.exe directorio [notas]');
const signingKey = process.env.TERRONES_UPDATE_SIGNING_PRIVATE_XML;
if (!signingKey) throw new Error('Falta TERRONES_UPDATE_SIGNING_PRIVATE_XML.');
const name = path.basename(packagePath).replace(/\s+/g, '-');
if (!/^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(name)) throw new Error('Nombre de instalador inseguro.');
const stat = fs.statSync(packagePath);
const digest = crypto.createHash('sha256');
const descriptor = fs.openSync(packagePath, 'r');
const buffer = Buffer.allocUnsafe(1024 * 1024);
try {
  for (;;) {
    const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
    if (!count) break;
    digest.update(buffer.subarray(0, count));
  }
} finally { fs.closeSync(descriptor); }
const manifest = Buffer.from(JSON.stringify({
  schema: 1, channel: 'visor', version: require('../package.json').version, publishedAt: new Date().toISOString(), notes,
  package: { name, size: stat.size, sha256: digest.digest('hex') },
}, null, 2));
fs.mkdirSync(outputDirectory, { recursive: true });
fs.copyFileSync(packagePath, path.join(outputDirectory, name));
fs.writeFileSync(path.join(outputDirectory, 'latest.json'), manifest);
fs.writeFileSync(path.join(outputDirectory, 'latest.json.sig'), crypto.sign('RSA-SHA256', manifest, privateKey(signingKey)).toString('base64'));
