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

module.exports = { configureDockerBackground };
