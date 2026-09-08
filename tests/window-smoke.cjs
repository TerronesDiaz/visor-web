// Run with Electron, not node --test. Uses a fixture server, never the real POS.
const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = process.env.TERRONES_SMOKE_MODULE_ROOT || path.join(__dirname, '..');
const { createMainWindow } = require(path.join(root, 'main-window.js'));
const output = path.join(__dirname, '..', 'runtime', 'window-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'user-data'));
app.disableHardwareAcceleration();
let host;
let status = { state: 'starting', phase: 'bootstrap', profiles: [{ active: true, displayName: 'Tienda de prueba' }] };
ipcMain.handle('runtime:status', () => status);
ipcMain.handle('profiles:list', () => ({ catalog: [], installed: [] }));
ipcMain.handle('provision:get-info', () => ({}));
const server = http.createServer((req, res) => {
  if (req.url === '/no-frames') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body><h1>Tienda sin fotogramas</h1><script>window.requestAnimationFrame = () => 1;</script></body></html>');
    return;
  }
  const finish = () => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<html><body style="margin:0;background:#f8fafc;font:28px Segoe UI;padding:60px"><h1>Tienda de prueba</h1><p>POS cargado en la misma ventana</p></body></html>'); };
  if (req.url === '/slow') setTimeout(finish, 700); else finish();
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: false, error: 'timeout' })); app.exit(1); }, 25000);
app.whenReady().then(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  host = createMainWindow({ BrowserWindow, WebContentsView, onClosed() {}, onPosCreated() {}, onError(message) {
    errors.push(message); status = { state: 'error', message: 'No fue posible iniciar Terrones POS', error: message };
    host.preparationContents.send('runtime:status-changed', status);
  } });
  await new Promise(resolve => host.preparationContents.once('did-finish-load', resolve));
  await delay(300);
  const id = host.window.id;
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  const pending = host.loadPos(`${url}/slow`);
  await delay(100);
  assert.equal(host.isPreparing(), true);
  fs.writeFileSync(path.join(output, 'preparing.png'), (await host.preparationContents.capturePage()).toPNG());
  assert.equal(await pending, true, JSON.stringify(errors));
  assert.equal(host.isPreparing(), false);
  assert.equal(host.window.id, id);
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  assert.equal(host.window.isMaximized(), true);
  await delay(150);
  fs.writeFileSync(path.join(output, 'ready.png'), (await host.contents.capturePage()).toPNG());
  assert.equal(await host.loadPos('http://127.0.0.1:1'), false);
  assert.equal(errors.length, 1);
  await delay(100);
  assert.equal(host.isPreparing(), true);
  fs.writeFileSync(path.join(output, 'error.png'), (await host.preparationContents.capturePage()).toPNG());
  assert.equal(await host.loadPos(url), true, JSON.stringify(errors));
  assert.equal(await host.loadPos(`${url}/no-frames`), true, JSON.stringify(errors));
  assert.equal(host.isPreparing(), false);
  const closing = host.loadPos(`${url}/slow`);
  host.window.close();
  assert.equal(await closing, false);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, singleWindow: true, maximized: true, retry: true, closeDuringLoad: true, moduleRoot: root }, null, 2));
  clearTimeout(deadline); server.close(); app.exit(0);
}).catch(error => {
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: false, error: error.stack }, null, 2));
  clearTimeout(deadline); server.close(); app.exit(1);
});
