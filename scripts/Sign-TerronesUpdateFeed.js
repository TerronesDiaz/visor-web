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

// Same rule as terrones_pos/installer/Sign-TerronesUpdateFeed.js: a line of its own,
// "Instalación: automática" or "Instalación: manual". No line means manual; an unknown
// value is an error, so a typo never publishes a release with another mode.
function installModeFromNotes(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/)
    .map((line) => line.trim().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase())
    .filter((line) => /^instalacion\s*:/.test(line));
  if (lines.length === 0) return 'manual';
  if (lines.length > 1) throw new Error('Las notas tienen más de una línea "Instalación:".');
  const mode = lines[0].replace(/^instalacion\s*:/, '').trim().replace(/\.$/, '');
  if (mode === 'automatica') return 'auto';
  if (mode === 'manual') return 'manual';
  throw new Error(`Modo de instalación desconocido en las notas: "${mode}". Usa "automática" o "manual".`);
}

function main() {
  if (process.argv[2] === '--install-mode') {
    process.stdout.write(`${installModeFromNotes(fs.readFileSync(process.argv[3], 'utf8'))}\n`);
    return;
  }
  const [packagePath, outputDirectory, notes = '', mode = 'manual'] = process.argv.slice(2);
  if (!packagePath || !outputDirectory) throw new Error('Uso: node Sign-TerronesUpdateFeed.js instalador.exe directorio [notas] [auto|manual]');
  if (!['auto', 'manual'].includes(mode)) throw new Error(`Modo de instalación inválido: ${mode}`);
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
    install: { mode },
    package: { name, size: stat.size, sha256: digest.digest('hex') },
  }, null, 2));
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.copyFileSync(packagePath, path.join(outputDirectory, name));
  fs.writeFileSync(path.join(outputDirectory, 'latest.json'), manifest);
  fs.writeFileSync(path.join(outputDirectory, 'latest.json.sig'), crypto.sign('RSA-SHA256', manifest, privateKey(signingKey)).toString('base64'));
}

if (require.main === module) main();
module.exports = { installModeFromNotes };
