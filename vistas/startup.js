const statusBox = document.getElementById('status');
const message = document.getElementById('message');
const detail = document.getElementById('detail');
const retry = document.getElementById('retry');
const diagnostics = document.getElementById('diagnostics');
const output = document.getElementById('output');

function render(status) {
  message.textContent = status.message || 'Preparando POS local…';
  detail.textContent = status.error || '';
  const failed = status.state === 'error';
  statusBox.classList.toggle('error', failed);
  retry.hidden = !failed;
  diagnostics.hidden = !failed;
}

window.terrones.runtime.onStatus(render);
window.terrones.runtime.getStatus().then(render);
retry.addEventListener('click', async () => { retry.hidden = true; await window.terrones.runtime.retry(); });
diagnostics.addEventListener('click', async () => {
  output.style.display = 'block';
  output.textContent = JSON.stringify(await window.terrones.runtime.getDiagnostics(), null, 2);
});
