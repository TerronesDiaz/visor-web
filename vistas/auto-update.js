const countdown = document.getElementById('countdown');
const postpone = document.getElementById('postpone');
const install = document.getElementById('install');
let remaining = 60;
let timer = null;
let answered = false;

async function respond(answer) {
  if (answered) return;
  answered = true;
  clearInterval(timer);
  postpone.disabled = true;
  install.disabled = true;
  countdown.textContent = answer === 'install' ? 'Iniciando la actualización…' : 'Pospuesta.';
  try { await window.terrones.updates.autoRespond(answer); }
  catch (_) { window.close(); }
}

function tick() {
  if (remaining <= 0) { respond('install'); return; }
  countdown.textContent = `Se instalará sola en ${remaining} s.`;
  remaining -= 1;
}

window.terrones.updates.autoInfo().then((info) => {
  remaining = Number(info.seconds) > 0 ? Number(info.seconds) : 60;
  document.getElementById('title').textContent = `Actualización lista: ${info.version}`;
  document.getElementById('impact').textContent = (info.light
    ? 'No cambia la base de datos: el POS se reinicia unos segundos al final y la venta puede continuar mientras se prepara.'
    : 'Terrones POS no se podrá usar durante la instalación (de 5 a 10 minutos).')
    + (info.visor ? ' El visor se cerrará un momento para actualizarse y se abrirá solo.' : '');
  document.getElementById('notes').textContent = info.notes || '';
  tick();
  timer = setInterval(tick, 1000);
  postpone.focus();
}).catch(() => window.close());

postpone.addEventListener('click', () => respond('snooze'));
install.addEventListener('click', () => respond('install'));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') respond('snooze'); });
