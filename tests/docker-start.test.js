const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// readyAfter: cuántas consultas `docker version` fallan antes de responder
// (Infinity = nunca responde). El reloj es simulado: cada espera avanza 3 s.
function fixture({ readyAfter = 0, failStart = false, desktopRunning = false, runKey = false } = {}) {
  const calls = [];
  let configured = 0;
  let versionChecks = 0;
  let clock = 0;
  let runKeyPresent = runKey;
  class FakeDate extends Date { static now() { return clock; } }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'local-runtime.js'), 'utf8') + '\nmodule.exports.testEnsureDocker = ensureDocker;', {
    module, process, Date: FakeDate,
    setTimeout(callback, milliseconds) { clock += milliseconds; setImmediate(callback); },
    require(name) {
      if (name === 'child_process') return { execFile(file, args, options, callback) {
        args = Array.from(args);
        calls.push({ file, args, options });
        let error = null;
        let stdout = '';
        if (file === 'docker.exe' && args[0] === 'version') {
          error = versionChecks++ < readyAfter;
          stdout = 'ready';
        } else if (file === 'docker.exe' && args[0] === 'desktop') {
          error = failStart;
        } else if (file === 'tasklist.exe') {
          stdout = desktopRunning && args[1] === 'IMAGENAME eq Docker Desktop.exe'
            ? '"Docker Desktop.exe","4120","Console","1","120,000 K"'
            : 'INFO: No tasks are running which match the specified criteria.';
        } else if (file === 'reg.exe') {
          if (args[0] === 'query') error = !runKeyPresent;
          if (args[0] === 'delete') runKeyPresent = false;
        }
        callback(error ? new Error('failed') : null, error ? '' : stdout, '');
      } };
      if (name === './profile-store') return {};
      if (name === './docker-settings') {
        const real = require('../docker-settings');
        return { configureDockerBackground() { configured++; }, disableDockerLoginStartup: real.disableDockerLoginStartup };
      }
      if (name === 'fs') return { existsSync: () => true };
      return require(name);
    },
  });
  const named = (file, first) => calls.filter(call => call.file === file && (!first || call.args[0] === first));
  return {
    run: module.exports.testEnsureDocker, calls, named,
    configured: () => configured, runKeyPresent: () => runKeyPresent,
  };
}

test('reutiliza Docker disponible sin volver a iniciarlo ni modificar preferencias', async () => {
  const f = fixture();
  await f.run(() => {});
  assert.equal(f.named('docker.exe').length, 1);
  assert.equal(f.configured(), 0);
});

test('arranque frío configura el panel y usa el comando oculto, esperando al motor', async () => {
  const f = fixture({ readyAfter: 1 });
  await f.run(() => {});
  assert.equal(f.configured(), 1);
  assert.deepEqual(f.named('docker.exe', 'desktop')[0].args, ['desktop', 'start', '--detach']);
  assert.equal(f.named('docker.exe', 'version').length, 2);
  assert.ok(f.calls.every(call => call.options.windowsHide === true));
});

test('si Windows ya está abriendo Docker, lo espera sin otra orden de inicio', async () => {
  const f = fixture({ readyAfter: 5, desktopRunning: true });
  await f.run(() => {});
  assert.equal(f.named('docker.exe', 'desktop').length, 0);
  assert.equal(f.configured(), 0);
  assert.equal(f.named('docker.exe', 'version').length, 6);
});

test('una orden de inicio fallida sigue esperando y entra cuando Docker responde', async () => {
  const f = fixture({ readyAfter: 4, failStart: true });
  await f.run(() => {});
  assert.equal(f.named('docker.exe', 'desktop').length, 1);
  assert.equal(f.named('docker.exe', 'version').length, 5);
});

test('si Docker nunca responde tras una orden fallida, muestra el error de segundo plano', async () => {
  const f = fixture({ readyAfter: Infinity, failStart: true });
  await assert.rejects(f.run(() => {}), /segundo plano/);
  assert.ok(!f.calls.some(call => /Docker Desktop\.exe$/i.test(call.file)), 'no abre el ejecutable gráfico');
});

test('si Docker nunca responde sin errores de inicio, pide revisar WSL2', async () => {
  const f = fixture({ readyAfter: Infinity, desktopRunning: true });
  await assert.rejects(f.run(() => {}), /tres minutos/);
});

test('quita el inicio automático de Docker con Windows para que no abra su ventana', async () => {
  for (const options of [{}, { readyAfter: 1 }]) {
    const f = fixture({ ...options, runKey: true });
    await f.run(() => {});
    assert.equal(f.runKeyPresent(), false);
    assert.deepEqual(f.named('reg.exe', 'delete')[0].args, ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'Docker Desktop', '/f']);
  }
  const clean = fixture();
  await clean.run(() => {});
  assert.equal(clean.named('reg.exe', 'delete').length, 0);
});

test('un fallo al quitar el inicio automático no impide abrir la tienda', async () => {
  const f = fixture({ runKey: true });
  const original = f.calls.push.bind(f.calls);
  f.calls.push = (call) => { if (call.file === 'reg.exe' && call.args[0] === 'delete') throw new Error('access denied'); return original(call); };
  await f.run(() => {});
  assert.equal(f.named('docker.exe', 'version').length, 1);
});
