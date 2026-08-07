const headline = document.getElementById('headline');
const state = document.getElementById('state');
const message = document.getElementById('message');
const updated = document.getElementById('updated');
const lag = document.getElementById('lag');
const pending = document.getElementById('pending');
const error = document.getElementById('error');
const output = document.getElementById('output');

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
}

async function refresh() {
  render(await window.terrones.runtime.getStatus());
}

window.terrones.runtime.onStatus(render);
document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('diagnostics').addEventListener('click', async () => {
  output.style.display = 'block';
  output.textContent = JSON.stringify(await window.terrones.runtime.getDiagnostics(), null, 2);
});
document.getElementById('close').addEventListener('click', () => window.terrones.window.close());
refresh().catch((exception) => {
  state.textContent = 'No fue posible leer el estado';
  message.textContent = exception.message;
});
