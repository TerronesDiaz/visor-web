const fs = require('node:fs');
const path = require('node:path');

// Only call before starting Desktop; it can overwrite settings while running.
function configureDockerBackground(appData = process.env.APPDATA) {
  if (!appData) throw new Error('No se encontró la configuración del usuario de Windows.');
  const directory = path.join(appData, 'Docker');
  fs.mkdirSync(directory, { recursive: true });
  const modern = path.join(directory, 'settings-store.json');
  const legacy = path.join(directory, 'settings.json');
  const files = [modern, legacy].filter(file => fs.existsSync(file));
  if (!files.length) files.push(modern);
  for (const file of files) {
    const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {};
    const key = file === modern ? 'OpenUIOnStartupDisabled' : 'openUIOnStartupDisabled';
    if (settings[key] === true) continue;
    settings[key] = true;
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), 'utf8');
      fs.renameSync(temporary, file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
}

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'Docker Desktop';

// Docker Desktop se registra en Run para abrirse al iniciar sesión, con su ventana
// al frente, aunque su opción AutoStart diga lo contrario. En la caja el visor es
// quien lo inicia (oculto, con `docker desktop start --detach`), así que se quita
// esa entrada. Solo afecta al usuario actual y se puede hacer con Docker abierto.
// `run(file, args)` devuelve una promesa; rechaza cuando el comando falla.
async function disableDockerLoginStartup(run) {
  try { await run('reg.exe', ['query', RUN_KEY, '/v', RUN_VALUE]); }
  catch (_) { return false; }
  await run('reg.exe', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
  return true;
}

module.exports = { configureDockerBackground, disableDockerLoginStartup };
