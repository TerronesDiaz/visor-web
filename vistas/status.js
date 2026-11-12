const byId = (id) => document.getElementById(id);
const output = byId('output');
const updateState = byId('updateState');
const installUpdate = byId('installUpdate');
const installPhases = byId('installPhases');
const lastAttempt = byId('lastAttempt');
const openLog = byId('openLog');
const profileList = byId('profileList');
const newProfile = byId('newProfile');
const enrollmentCode = byId('enrollmentCode');
const enrollProfile = byId('enrollProfile');
const profileMessage = byId('profileMessage');
const supportMessage = byId('supportMessage');

const labels = {
  synced: 'Al día',
  up_to_date: 'Al día',
  catching_up: 'Actualizándose',
  connecting: 'Conectando',
  offline: 'Sin internet',
  error: 'Error de sincronización',
  disabled: 'No configurada',
};
const cloudLevels = { synced: 'ok', up_to_date: 'ok', catching_up: 'warn', connecting: 'warn', offline: 'warn', error: 'bad' };

// Same phase ids as update-runtime.js INSTALL_PHASES and Show-UpdateProgress.ps1.
const phaseLabels = [
  ['prepare', 'Preparar la actualización'],
  ['backup', 'Respaldar la base de datos'],
  ['install', 'Instalar la versión nueva'],
  ['migrate', 'Actualizar la base de datos'],
  ['start', 'Iniciar Terrones POS'],
  ['verify', 'Comprobar que todo funcione'],
];
const featureLabels = {
  'visor-abierto': 'muestra el avance sin cerrar el visor',
  recuperacion: 'se recupera de un reinicio',
  ligera: 'actualizaciones ligeras',
};

let activeStoreName = '';

function describeCloudUpdate(update) {
  if (!update) return 'Sin dato';
  if (update.state === 'completed') return `Al día${update.version ? ` (${update.version})` : ''}`;
  if (update.state === 'waiting') return update.message || 'Esperando esta caja';
  if (update.state === 'installing') return 'Actualizándose…';
  if (update.state === 'blocked') return `Detenida: ${update.message || 'sin detalle'}`;
  if (update.state === 'error') return `Error: ${update.message || 'sin detalle'}`;
  return update.message || update.state || 'Sin dato';
}

function formatDate(value) {
  if (!value) return 'Sin registro';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('es-MX');
}

// "hace 3 min", "hoy 6:00", "ayer 21:15" or the full date for anything older.
function formatRecent(value) {
  if (!value) return 'Sin registro';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return 'hace un momento';
  if (minutes < 60) return `hace ${minutes} min`;
  const time = date.toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' });
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  if (date >= startOfToday) return `hoy ${time}`;
  if (date >= new Date(startOfToday.getTime() - 86400000)) return `ayer ${time}`;
  return date.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
}

function setTile(id, level, value, detail = '') {
  const tile = byId(id);
  tile.className = `tile ${level || ''}`.trim();
  tile.querySelector('.value').textContent = value;
  tile.querySelector('.detail').textContent = detail;
}

function renderPhases(install) {
  // A light update does not back up: it touches no database.
  const phases = install.light ? phaseLabels.filter(([id]) => id !== 'backup') : phaseLabels;
  const current = phases.findIndex(([id]) => id === install.phase);
  installPhases.replaceChildren(...phases.map(([, label], index) => {
    const item = document.createElement('li');
    if (current >= 0 && index < current) { item.className = 'done'; item.textContent = `✓ ${label}`; }
    else if (index === current) { item.className = 'current'; item.textContent = `► ${label}`; }
    else item.textContent = `○ ${label}`;
    return item;
  }));
}

function render(status) {
  const sync = status.sync || status;
  const syncState = sync.state || 'unknown';
  const cloudLabel = labels[syncState] || 'Estado desconocido';
  setTile('tileCloud', cloudLevels[syncState] || '', cloudLabel, sync.updatedAt ? formatRecent(sync.updatedAt) : (sync.message || ''));
  byId('syncState').textContent = sync.message || cloudLabel;
  byId('updated').textContent = formatDate(sync.updatedAt);
  byId('lag').textContent = sync.replicaLagSeconds == null ? 'Sin dato' : `${sync.replicaLagSeconds} s`;
  byId('pending').textContent = String(sync.pendingMedia ?? 0);
  byId('error').textContent = syncState === 'error' ? (sync.message || 'Error sin detalle') : 'Ninguno';
  byId('cloudVersion').textContent = sync.cloudAppVersion || 'Sin registro';
  byId('cloudUpdate').textContent = describeCloudUpdate(sync.cloudUpdate);
  const active = (status.profiles || []).find((profile) => profile.active);
  if (active) activeStoreName = active.displayName;
  if (status.updates) renderUpdates(status.updates);
}

function badge(text, kind) {
  const element = document.createElement('span');
  element.className = `badge ${kind || ''}`.trim();
  element.textContent = text;
  return element;
}

// What will happen with the pending release, in the cashier's words.
function describePlan(update) {
  const parts = [];
  if (update.mode === 'auto') {
    if (update.auto?.blocked === 'failed') parts.push('Es automática, pero ya falló en esta caja: revisa el registro e instálala con el botón.');
    else if (update.auto?.blocked === 'attempts') parts.push('Es automática, pero ya se intentó dos veces sin quedar instalada: instálala con el botón.');
    else parts.push('Se instalará sola al abrir Terrones POS, o cuando la caja lleve dos minutos sin uso y no haya una venta en curso. También puedes instalarla ahora.');
  } else {
    parts.push('Espera a que alguien pulse Instalar actualización.');
  }
  if (update.light) parts.push('No cambia la base de datos: se puede seguir vendiendo mientras se prepara y el POS se reinicia unos segundos al final.');
  else if (update.available.pos) parts.push('El POS no se podrá usar mientras se instala (de 5 a 10 minutos).');
  if (update.available.visor) parts.push('El visor se cerrará un momento para actualizarse y se abrirá solo.');
  return parts.join(' ');
}

function renderUpdates(update) {
  const pending = update.available.pos || update.available.visor;
  const names = [update.available.pos ? `POS ${update.available.pos}` : '', update.available.visor ? `visor ${update.available.visor}` : ''].filter(Boolean).join(' y ');
  byId('headerVersions').textContent = [activeStoreName, `POS ${update.installed.pos}`, `Visor ${update.installed.visor}`].filter(Boolean).join(' · ');
  byId('updateTitle').textContent = pending ? `Actualización: ${names}` : 'Actualizaciones';
  const badges = [];
  if (pending) {
    badges.push(update.mode === 'auto' ? badge('Automática', 'auto') : badge('Manual'));
    if (update.light) badges.push(badge('Ligera · segundos de pausa', 'light'));
    else if (update.available.pos) badges.push(badge('Completa · 5 a 10 minutos', 'full'));
    else badges.push(badge('Solo el visor'));
  }
  byId('updateBadges').replaceChildren(...badges);
  updateState.textContent = update.message || 'Sin información de actualización.';
  const plan = byId('updatePlan');
  plan.hidden = !(update.canInstall && pending);
  if (!plan.hidden) plan.textContent = describePlan(update);
  byId('releaseNotes').textContent = update.notes || '';

  installPhases.hidden = !(update.state === 'installing' && update.install);
  if (!installPhases.hidden) renderPhases(update.install);
  const attempt = update.lastAttempt;
  // An error is already the main message; repeating it here would only add noise.
  lastAttempt.hidden = !attempt || update.state === 'error' || update.state === 'installing';
  if (!lastAttempt.hidden) {
    const succeeded = attempt.state === 'completed';
    lastAttempt.style.color = succeeded ? '#4ade80' : '#f87171';
    lastAttempt.textContent = `Último intento (${formatDate(attempt.at)}): ${succeeded ? '✓' : '✗'} ${attempt.message}`
      + (attempt.error ? ` ${attempt.error}` : '');
  }
  openLog.hidden = !(update.install?.log || attempt?.log);
  installUpdate.hidden = !update.canInstall;
  installUpdate.disabled = update.state === 'installing';
  installUpdate.textContent = update.mode === 'auto' && !update.auto?.blocked ? 'Instalar ahora' : 'Instalar actualización';
  const updateProgress = byId('updateProgress');
  const total = Number(update.progress?.totalBytes || 0);
  const downloaded = Number(update.progress?.downloadedBytes || 0);
  updateProgress.hidden = update.state !== 'downloading';
  if (total > 0) {
    updateProgress.max = 100;
    updateProgress.value = Math.min(100, Math.round(downloaded * 100 / total));
  } else {
    updateProgress.removeAttribute('value');
  }

  byId('posInstalled').textContent = update.installed.pos + (update.installed.installedAt ? ` · ${formatRecent(update.installed.installedAt)}` : '');
  byId('visorInstalled').textContent = update.installed.visor;
  byId('availableVersions').textContent = pending ? names : 'Nada pendiente';
  byId('availableMode').textContent = pending
    ? `${update.mode === 'auto' ? 'Automática' : 'Manual'} · ${update.light ? 'ligera' : (update.available.pos ? 'completa' : 'solo el visor')}`
    : '—';
  renderHistory(update.history || []);
}

function renderHistory(attempts) {
  byId('historyEmpty').hidden = attempts.length > 0;
  byId('historyTable').hidden = attempts.length === 0;
  byId('historyRows').replaceChildren(...attempts.map((attempt) => {
    const row = document.createElement('tr');
    const succeeded = attempt.state === 'completed';
    const cells = [formatDate(attempt.at), attempt.version || '—', `${succeeded ? '✓' : '✗'} ${attempt.message || ''}${attempt.error ? ` ${attempt.error}` : ''}`];
    cells.forEach((text, index) => {
      const cell = document.createElement('td');
      cell.textContent = text;
      if (index === 2) cell.className = succeeded ? 'ok' : 'failed';
      row.appendChild(cell);
    });
    return row;
  }));
}

function renderSupport(summary) {
  setTile('tilePos', summary.posReady ? 'ok' : 'bad', summary.posReady ? 'Operativa' : 'No responde',
    summary.posReady ? (activeStoreName || '') : 'Cierra y vuelve a abrir Terrones POS.');
  const printing = summary.printing || {};
  if (!printing.running) setTile('tilePrinter', 'bad', 'Servicio detenido', 'Cierra y vuelve a abrir Terrones POS.');
  else if (!printing.printerConfigured) setTile('tilePrinter', 'warn', 'Sin impresora', 'Elige una impresora predeterminada en Windows.');
  else setTile('tilePrinter', 'ok', 'Lista', printing.printer || '');
  const backup = summary.backup;
  if (!backup) setTile('tileBackup', 'warn', 'Sin respaldos', 'Todavía no hay ninguno en esta caja.');
  else {
    const hours = (Date.now() - new Date(backup.at).getTime()) / 3600000;
    setTile('tileBackup', hours <= 36 ? 'ok' : 'warn', formatRecent(backup.at), hours <= 36 ? '' : 'Hace más de un día.');
  }
  const features = summary.updaterFeatures || [];
  byId('updaterFeatures').textContent = features.length
    ? features.map((feature) => featureLabels[feature] || feature).join(', ')
    : 'Versión anterior: cierra el visor para actualizar';
}

async function refresh() {
  render(await window.terrones.runtime.getStatus());
  await renderProfiles();
}

async function refreshSupport() {
  renderSupport(await window.terrones.support.summary());
}

async function renderProfiles() {
  const profiles = await window.terrones.profiles.list();
  profileList.replaceChildren();
  for (const profile of profiles.installed) {
    const row = document.createElement('div');
    row.className = 'profile-row';
    const summary = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `${profile.displayName}${profile.active ? ' · activa' : ''}`;
    const meta = document.createElement('div');
    meta.className = 'profile-meta';
    meta.textContent = profile.enrollmentPending ? 'Modo de validación · ventas bloqueadas' : (profile.provisioned ? (profile.sync?.message || 'Configurada') : 'Pendiente de enrolamiento');
    summary.append(title, meta);
    row.appendChild(summary);
    if (profile.enrollmentPending) {
      const button = document.createElement('button');
      button.textContent = 'Finalizar';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const result = await window.terrones.profiles.finalize(profile.id);
          if (!result?.canceled) { profileMessage.textContent = `${profile.displayName} ya permite ventas.`; await renderProfiles(); }
          else button.disabled = false;
        } catch (exception) { profileMessage.textContent = exception.message; button.disabled = false; }
      });
      row.appendChild(button);
    } else if (profile.provisioned && !profile.active) {
      const button = document.createElement('button');
      button.textContent = 'Cambiar';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const result = await window.terrones.profiles.switchTo(profile.id);
          if (!result?.canceled) window.close();
        } catch (exception) { profileMessage.textContent = exception.message; button.disabled = false; }
      });
      row.appendChild(button);
    }
    profileList.appendChild(row);
  }
  const installedIds = new Set(profiles.installed.map((profile) => profile.id));
  const selectable = profiles.catalog.filter((profile) => !installedIds.has(profile.id) || !profiles.installed.find((item) => item.id === profile.id)?.provisioned);
  // The list refreshes every few seconds; keep what the person had chosen.
  const chosen = newProfile.value;
  newProfile.replaceChildren(...selectable.map((profile) => {
    const option = document.createElement('option'); option.value = profile.id; option.textContent = profile.displayName; return option;
  }));
  if (selectable.some((profile) => profile.id === chosen)) newProfile.value = chosen;
  enrollProfile.disabled = selectable.length === 0;
  enrollmentCode.disabled = selectable.length === 0;
}

const tabs = [...document.querySelectorAll('nav [role="tab"]')];
function selectTab(tab, focus = false) {
  for (const candidate of tabs) {
    const selected = candidate === tab;
    candidate.setAttribute('aria-selected', String(selected));
    candidate.tabIndex = selected ? 0 : -1;
    byId(candidate.getAttribute('aria-controls')).hidden = !selected;
  }
  if (focus) tab.focus();
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') selectTab(tabs[(index + 1) % tabs.length], true);
    if (event.key === 'ArrowLeft') selectTab(tabs[(index + tabs.length - 1) % tabs.length], true);
  });
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'F9' || event.key === 'Escape') { event.preventDefault(); window.close(); }
});

window.terrones.runtime.onStatus(render);
byId('refresh').addEventListener('click', () => { refresh().catch(() => {}); refreshSupport().catch(() => {}); });
installUpdate.addEventListener('click', async () => {
  installUpdate.disabled = true;
  try {
    const result = await window.terrones.updates.install();
    if (result?.canceled) installUpdate.disabled = false;
  } catch (exception) {
    updateState.textContent = exception.message;
    installUpdate.disabled = false;
  }
});
openLog.addEventListener('click', async () => {
  try { await window.terrones.updates.openLog(); }
  catch (exception) { updateState.textContent = exception.message; }
});
byId('diagnostics').addEventListener('click', async () => {
  output.style.display = 'block';
  output.textContent = JSON.stringify(await window.terrones.runtime.getDiagnostics(), null, 2);
});
byId('copyDiagnostics').addEventListener('click', async () => {
  try {
    await window.terrones.support.copyDiagnostics();
    supportMessage.textContent = 'Diagnóstico copiado. Pégalo en el mensaje a soporte.';
  } catch (exception) { supportMessage.textContent = exception.message; }
});
for (const [id, which] of [['openPosLogs', 'pos'], ['openVisorLogs', 'visor']]) {
  byId(id).addEventListener('click', async () => {
    try { await window.terrones.support.openLogs(which); supportMessage.textContent = ''; }
    catch (exception) { supportMessage.textContent = exception.message; }
  });
}
enrollProfile.addEventListener('click', async () => {
  const code = enrollmentCode.value.trim();
  if (!code) { profileMessage.textContent = 'Escribe el código generado en el VPS.'; return; }
  enrollProfile.disabled = true;
  profileMessage.textContent = 'Preparando la tienda…';
  try {
    await window.terrones.profiles.enroll(newProfile.value, code);
    profileMessage.textContent = 'Tienda agregada correctamente.';
    enrollmentCode.value = '';
    await renderProfiles();
  } catch (exception) {
    profileMessage.textContent = exception.message;
  } finally { enrollProfile.disabled = false; }
});
byId('close').addEventListener('click', () => window.close());
refresh().catch((exception) => {
  setTile('tileCloud', 'bad', 'No fue posible leer el estado', exception.message);
});
refreshSupport().catch(() => {});
setInterval(() => refresh().catch(() => {}), 3000);
setInterval(() => refreshSupport().catch(() => {}), 10000);
