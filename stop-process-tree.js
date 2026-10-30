const { execFile } = require('node:child_process');

// The packaged printer has a bootloader and a child; killing only the parent
// leaves the child running and blocks the installer.
async function stopProcessTree(child, { platform = process.platform, run = execFile } = {}) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (platform === 'win32') {
    await new Promise((resolve, reject) => {
      run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, timeout: 10000 }, (error) => {
          if (error && child.exitCode === null && child.signalCode === null) reject(error);
          else resolve();
        });
    });
    return;
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener('close', closed);
      reject(new Error('El servicio de impresión no terminó de cerrarse.'));
    }, 10000);
    function closed() { clearTimeout(timer); resolve(); }
    child.once('close', closed);
    child.kill();
  });
}

module.exports = { stopProcessTree };
