const test = require('node:test');
const assert = require('node:assert/strict');
const { stopProcessTree } = require('../stop-process-tree');

test('Windows shutdown targets only owned PID and all descendants without a console', async () => {
  const child = { pid: 123, exitCode: null, signalCode: null };
  await stopProcessTree(child, { platform: 'win32', run(command, args, options, callback) {
    assert.equal(command, 'taskkill.exe');
    assert.deepEqual(args, ['/PID', '123', '/T', '/F']);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 10000);
    callback(null);
  } });
});

test('shutdown reports failure while printer remains alive', async () => {
  await assert.rejects(stopProcessTree({ pid: 123, exitCode: null, signalCode: null }, {
    platform: 'win32', run(command, args, options, callback) { callback(new Error('Access denied')); },
  }), /Access denied/);
});

test('already exited processes are never targeted by a reused PID', async () => {
  await stopProcessTree({ pid: 123, exitCode: 0, signalCode: null }, {
    platform: 'win32', run() { assert.fail('must not run'); },
  });
});
