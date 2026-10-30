const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture(initiallyReady, failStart = false) {
  const calls = [];
  let configured = 0;
  let checks = 0;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'local-runtime.js'), 'utf8') + '\nmodule.exports.testEnsureDocker = ensureDocker;', {
    module, process, setTimeout,
    require(name) {
      if (name === 'child_process') return { execFile(file, args, options, callback) {
        calls.push({ file, args: Array.from(args), options });
        const error = args[0] === 'version' ? (!initiallyReady && checks++ === 0) : failStart;
        callback(error ? new Error('not ready') : null, error ? '' : 'ready', '');
      } };
      if (name === './profile-store') return {};
      if (name === './docker-settings') return { configureDockerBackground() { configured++; } };
      if (name === 'fs') return { existsSync: () => true };
      return require(name);
    },
  });
  return { run: module.exports.testEnsureDocker, calls, configured: () => configured };
}

test('reutiliza Docker disponible sin volver a iniciarlo ni modificar preferencias', async () => {
  const f = fixture(true); await f.run(() => {});
  assert.equal(f.calls.length, 1);
  assert.equal(f.configured(), 0);
});

test('arranque frío configura el panel y usa el comando oculto, esperando al motor', async () => {
  const f = fixture(false); await f.run(() => {});
  assert.equal(f.configured(), 1);
  assert.deepEqual(f.calls[1].args, ['desktop', 'start', '--detach']);
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every(call => call.options.windowsHide === true));
});

test('un arranque fallido muestra un error y no abre el ejecutable gráfico', async () => {
  const f = fixture(false, true);
  await assert.rejects(f.run(() => {}), /segundo plano/);
  assert.equal(f.calls.length, 2);
});
