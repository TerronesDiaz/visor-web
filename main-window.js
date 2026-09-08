const path = require('node:path');

// The preparation view covers the POS while it renders, including on retries.
// Both views remain attached to the same native window throughout its lifetime.
function createMainWindow({ BrowserWindow, WebContentsView, onError, onClosed, onPosCreated }) {
  const preferences = {
    nodeIntegration: false, contextIsolation: true, sandbox: true,
    preload: path.join(__dirname, 'preload.js'),
  };
  const win = new BrowserWindow({
    width: 1100, height: 760, show: false, autoHideMenuBar: true,
    title: 'Terrones POS', backgroundColor: '#0f172a', webPreferences: preferences,
    icon: path.join(__dirname, 'logo.png'),
  });
  let closed = false;
  let loading = null;
  let resolveClosed;
  const closedSignal = new Promise(resolve => { resolveClosed = resolve; });
  const view = new WebContentsView({ webPreferences: { ...preferences, backgroundThrottling: false } });
  const cover = new WebContentsView({ webPreferences: preferences });
  view.setBackgroundColor('#ffffff');
  cover.setBackgroundColor('#0f172a');
  win.contentView.addChildView(view);
  win.contentView.addChildView(cover);
  const resize = () => {
    const [width, height] = win.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height });
    cover.setBounds({ x: 0, y: 0, width, height });
  };
  win.on('resize', resize);
  win.once('ready-to-show', async () => {
    await preparation.catch(() => {});
    if (closed) return;
    win.maximize();
    resize();
    win.show();
  });
  win.on('closed', () => {
    closed = true;
    resolveClosed(false);
    if (!view.webContents.isDestroyed()) view.webContents.close();
    if (!cover.webContents.isDestroyed()) cover.webContents.close();
    onClosed();
  });
  const preparation = cover.webContents.loadFile(path.join(__dirname, 'vistas', 'startup.html'));
  win.loadURL('about:blank').catch(error => { if (!closed) onError(error.message); });
  preparation.catch(error => { if (!closed) onError(error.message); });
  view.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (!closed && isMainFrame && code !== -3 && !loading) {
      cover.setVisible(true);
      onError(`El POS local dejó de responder (${code}: ${description}).`);
    }
  });
  view.webContents.on('render-process-gone', () => {
    if (!closed) { cover.setVisible(true); onError('El POS dejó de responder. Puedes reintentar.'); }
  });
  onPosCreated(view.webContents);
  return {
    window: win,
    contents: view.webContents,
    preparationContents: cover.webContents,
    isPreparing() { return cover.getVisible(); },
    showPreparation() { if (!closed) cover.setVisible(true); },
    async loadPos(url) {
      if (closed) return false;
      if (loading) return loading;
      cover.setVisible(true);
      loading = Promise.resolve().then(async () => {
        let timer;
        try {
          const navigation = (async () => {
            await view.webContents.loadURL(url);
            if (closed) return false;
            // Wait for a rendered frame as well as successful navigation.
            await view.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
            return true;
          })();
          const loaded = await Promise.race([navigation, closedSignal, new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('La tienda tardó demasiado en cargar.')), 30000);
          })]);
          if (!loaded || closed) return false;
          resize();
          cover.setVisible(false);
          if (win.isFocused()) view.webContents.focus();
          return true;
        } catch (error) {
          if (!closed) { view.webContents.stop(); onError(`No fue posible cargar el POS local: ${error.message}`); }
          return false;
        } finally { clearTimeout(timer); loading = null; }
      });
      return loading;
    },
  };
}

module.exports = { createMainWindow };
