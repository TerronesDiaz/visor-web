const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configureDockerBackground } = require('../docker-settings');

test('oculta el panel sin cambiar preferencias, en ambos formatos de Docker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-settings-'));
  try {
    fs.mkdirSync(path.join(root, 'Docker'));
    for (const [name, key] of [['settings-store.json', 'OpenUIOnStartupDisabled'], ['settings.json', 'openUIOnStartupDisabled']]) {
      fs.writeFileSync(path.join(root, 'Docker', name), JSON.stringify({ [key]: false, autoStart: false, resources: { memory: 4096 } }));
    }
    configureDockerBackground(root);
    configureDockerBackground(root);
    for (const [name, key] of [['settings-store.json', 'OpenUIOnStartupDisabled'], ['settings.json', 'openUIOnStartupDisabled']]) {
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'Docker', name))), { [key]: true, autoStart: false, resources: { memory: 4096 } });
    }
    const modern = path.join(root, 'Docker', 'settings-store.json');
    fs.writeFileSync(modern, '{invalid');
    assert.throws(() => configureDockerBackground(root));
    assert.equal(fs.readFileSync(modern, 'utf8'), '{invalid');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
