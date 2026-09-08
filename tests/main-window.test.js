const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createMainWindow } = require('../main-window');

function fixture() {
  const errors = [];
  let windows = 0;
  let view;
  let posView;
  let resolveLoad;
  let rejectLoad;
  class Contents extends EventEmitter {
    isDestroyed() { return Boolean(this.closed); }
    close() { this.closed = true; }
    loadURL() { return new Promise((resolve, reject) => { resolveLoad = resolve; rejectLoad = reject; }); }
    loadFile() { return Promise.resolve(); }
    executeJavaScript() { return Promise.resolve(); }
    stop() {}
    focus() { this.focused = true; }
  }
  class Window extends EventEmitter {
    constructor(options) {
      super(); windows++; this.options = options;
      this.contentView = { addChildView(v) { if (!posView) posView = v; else view = v; } };
    }
    loadFile() { return Promise.resolve(); }
    loadURL() { return Promise.resolve(); }
    maximize() { this.maximizes = (this.maximizes || 0) + 1; }
    show() { this.shows = (this.shows || 0) + 1; }
    isFocused() { return false; }
    getContentSize() { return [1200, 800]; }
  }
  class View {
    constructor(options) { this.options = options; this.webContents = new Contents(); }
    setVisible(value) { this.visible = value; }
    getVisible() { return this.visible !== false; }
    setBackgroundColor() {}
    setBounds(value) { this.bounds = value; }
  }
  const host = createMainWindow({ BrowserWindow: Window, WebContentsView: View,
    onError: error => errors.push(error), onClosed() {}, onPosCreated() {} });
  return { host, view, errors, windows: () => windows, finish: () => resolveLoad(), fail: () => rejectLoad(new Error('network')) };
}

test('conserva la presentación hasta cargar el POS, sin otra ventana o cambio de foco', async () => {
  const f = fixture();
  f.host.window.emit('ready-to-show');
  await Promise.resolve();
  await Promise.resolve();
  const first = f.host.loadPos('http://localhost');
  const second = f.host.loadPos('http://localhost');
  await Promise.resolve();
  assert.equal(f.view.visible, true);
  f.finish();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(f.view.visible, false);
  assert.equal(f.windows(), 1);
  assert.equal(f.host.window.shows, 1);
  assert.equal(f.host.window.maximizes, 1);
  assert.equal(f.host.contents.focused, undefined);
  assert.deepEqual(f.view.bounds, { x: 0, y: 0, width: 1200, height: 800 });
  assert.equal(f.view.options.webPreferences.sandbox, true);
});

test('un error conserva la presentación y permite reintentar', async () => {
  const f = fixture();
  const first = f.host.loadPos('http://localhost'); await Promise.resolve(); f.fail();
  assert.equal(await first, false);
  assert.equal(f.view.visible, true);
  assert.equal(f.errors.length, 1);
  const retry = f.host.loadPos('http://localhost'); await Promise.resolve(); f.finish();
  assert.equal(await retry, true);
});

test('cerrar durante la carga destruye el contenido y nunca vuelve a mostrarlo', async () => {
  const f = fixture();
  const pending = f.host.loadPos('http://localhost');
  await Promise.resolve();
  f.host.window.emit('closed'); f.fail();
  assert.equal(await pending, false);
  assert.equal(f.host.contents.isDestroyed(), true);
  assert.equal(f.view.visible, true);
  assert.deepEqual(f.errors, []);
  assert.equal(await f.host.loadPos('http://localhost'), false);
});

test('ignora fallos de subframes y navegaciones canceladas', () => {
  const f = fixture();
  f.host.contents.emit('did-fail-load', {}, -105, 'image', '', false);
  f.host.contents.emit('did-fail-load', {}, -3, 'aborted', '', true);
  assert.deepEqual(f.errors, []);
  f.host.contents.emit('did-fail-load', {}, -105, 'offline', '', true);
  assert.equal(f.errors.length, 1);
});

test('permite reintentar incluso cuando loadURL lanza un error sincrónico', async () => {
  const f = fixture();
  const load = f.host.contents.loadURL;
  f.host.contents.loadURL = () => { throw new Error('invalid URL'); };
  assert.equal(await f.host.loadPos('invalid'), false);
  f.host.contents.loadURL = load;
  const retry = f.host.loadPos('http://localhost');
  await Promise.resolve(); f.finish();
  assert.equal(await retry, true);
});
