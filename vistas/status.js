const headline = document.getElementById('headline');
const state = document.getElementById('state');
const message = document.getElementById('message');
const updated = document.getElementById('updated');
const lag = document.getElementById('lag');
const pending = document.getElementById('pending');
const error = document.getElementById('error');
const cloudVersion = document.getElementById('cloudVersion');
const output = document.getElementById('output');
const updateState = document.getElementById('updateState');
const versions = document.getElementById('versions');
const releaseNotes = document.getElementById('releaseNotes');
const installUpdate = document.getElementById('installUpdate');
const updateProgress = document.getElementById('updateProgress');
const profileList = document.getElementById('profileList');
const newProfile = document.getElementById('newProfile');
const enrollmentCode = document.getElementById('enrollmentCode');
const enrollProfile = document.getElementById('enrollProfile');
const profileMessage = document.getElementById('profileMessage');

const labels = {
  synced: 'Nube al día',
  up_to_date: 'Nube al día',
  catching_up: 'Nube actualizándose',
  connecting: 'Conectando con la nube',
  offline: 'Sin conexión a internet',
  error: 'Error de sincronización',
  disabled: 'Nube no configurada',
};

function formatDate(value) {
  if (!value) return 'Sin registro';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('es-MX');
}

function render(status) {
  const sync = status.sync || status;
  const syncState = sync.state || 'unknown';
  headline.className = `headline ${syncState === 'up_to_date' ? 'synced' : syncState}`;
  state.textContent = labels[syncState] || 'Estado desconocido';
  message.textContent = sync.message || '';
  updated.textContent = formatDate(sync.updatedAt);
  lag.textContent = sync.replicaLagSeconds == null ? 'Sin dato' : `${sync.replicaLagSeconds} s`;
  pending.textContent = String(sync.pendingMedia ?? 0);
  error.textContent = syncState === 'error' ? (sync.message || 'Error sin detalle') : 'Ninguno';
  cloudVersion.textContent = sync.cloudAppVersion || 'Sin registro';
  if (status.updates) renderUpdates(status.updates);
}

function renderUpdates(update) {
  updateState.textContent = update.message || 'Sin información de actualización.';
  versions.textContent = `POS instalado: ${update.installed.pos} · Visor instalado: ${update.installed.visor}` +
    (update.available.pos || update.available.visor ? ` · Disponible: ${update.available.pos || update.available.visor}` : '');
  releaseNotes.textContent = update.notes || '';
  installUpdate.hidden = !update.canInstall;
  installUpdate.disabled = update.state === 'installing';
  const total = Number(update.progress?.totalBytes || 0);
  const downloaded = Number(update.progress?.downloadedBytes || 0);
  updateProgress.hidden = update.state !== 'downloading';
  if (total > 0) {
    updateProgress.max = 100;
    updateProgress.value = Math.min(100, Math.round(downloaded * 100 / total));
  } else {
    updateProgress.removeAttribute('value');
  }
}

async function refresh() {
  render(await window.terrones.runtime.getStatus());
  await renderProfiles();
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
          if (!result?.canceled) window.terrones.window.close();
        } catch (exception) { profileMessage.textContent = exception.message; button.disabled = false; }
      });
      row.appendChild(button);
    }
    profileList.appendChild(row);
  }
  const installedIds = new Set(profiles.installed.map((profile) => profile.id));
  const selectable = profiles.catalog.filter((profile) => !installedIds.has(profile.id) || !profiles.installed.find((item) => item.id === profile.id)?.provisioned);
  newProfile.replaceChildren(...selectable.map((profile) => {
    const option = document.createElement('option'); option.value = profile.id; option.textContent = profile.displayName; return option;
  }));
  enrollProfile.disabled = selectable.length === 0;
  enrollmentCode.disabled = selectable.length === 0;
}

window.terrones.runtime.onStatus(render);
document.getElementById('refresh').addEventListener('click', refresh);
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
document.getElementById('diagnostics').addEventListener('click', async () => {
  output.style.display = 'block';
  output.textContent = JSON.stringify(await window.terrones.runtime.getDiagnostics(), null, 2);
});
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
document.getElementById('close').addEventListener('click', () => window.terrones.window.close());
refresh().catch((exception) => {
  state.textContent = 'No fue posible leer el estado';
  message.textContent = exception.message;
});
setInterval(() => refresh().catch(() => {}), 3000);
