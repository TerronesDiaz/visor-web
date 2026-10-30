const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('abre el POS maximizado sin bloquear Windows en modo kiosco', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main-window.js'), 'utf8');
  assert.doesNotMatch(source, /kiosk\s*:\s*true/);
  assert.match(source, /win\.maximize\(\)/);
  assert.doesNotMatch(source, /win\.setKiosk\(/);
});
