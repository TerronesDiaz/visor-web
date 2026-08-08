const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { publicKeyFromXml } = require('../update-runtime');

const [directory, expectedChannel, publicKeyFile] = process.argv.slice(2);
if (!directory || !expectedChannel || !publicKeyFile) {
  throw new Error('Uso: node Verify-TerronesUpdateFeed.js directorio canal clave-publica.xml');
}

const manifestPath = path.join(directory, 'latest.json');
const signaturePath = path.join(directory, 'latest.json.sig');
const bytes = fs.readFileSync(manifestPath);
const signature = Buffer.from(fs.readFileSync(signaturePath, 'utf8').trim(), 'base64');
const key = publicKeyFromXml(fs.readFileSync(publicKeyFile, 'utf8'));
if (!crypto.verify('RSA-SHA256', bytes, key, signature)) throw new Error('Firma inválida.');

const manifest = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
if (manifest.schema !== 1 || manifest.channel !== expectedChannel || !manifest.version || !manifest.package) {
  throw new Error('Manifiesto incompatible.');
}
if (!/^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(manifest.package.name)) throw new Error('Nombre de paquete inseguro.');
const packagePath = path.join(directory, manifest.package.name);
const stat = fs.statSync(packagePath);
if (stat.size !== Number(manifest.package.size)) throw new Error('Tamaño incorrecto.');
const hash = crypto.createHash('sha256').update(fs.readFileSync(packagePath)).digest('hex');
if (hash !== String(manifest.package.sha256).toLowerCase()) throw new Error('SHA-256 incorrecto.');
process.stdout.write(`${manifest.channel} ${manifest.version} verificado\n`);
