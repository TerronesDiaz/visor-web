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

const signingKey = process.env.TERRONES_UPDATE_SIGNING_PRIVATE_XML;
if (!signingKey) throw new Error('Falta TERRONES_UPDATE_SIGNING_PRIVATE_XML.');
const catalog = path.join(__dirname, '..', 'store-catalog.json');
const bytes = fs.readFileSync(catalog);
fs.writeFileSync(`${catalog}.sig`, crypto.sign('RSA-SHA256', bytes, privateKey(signingKey)).toString('base64'));
