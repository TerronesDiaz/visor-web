const statusBox = document.getElementById('status');
const message = document.getElementById('message');
const detail = document.getElementById('detail');
const provisionPanel = document.getElementById('provisionPanel');
const profilePanel = document.getElementById('profilePanel');
const readyPanel = document.getElementById('readyPanel');
const recipient = document.getElementById('recipient');
const copyRecipient = document.getElementById('copyRecipient');
const importBundle = document.getElementById('importBundle');
const openPos = document.getElementById('openPos');
const errorActions = document.getElementById('errorActions');
const retry = document.getElementById('retry');
const diagnostics = document.getElementById('diagnostics');
const output = document.getElementById('output');
const profileSelect = document.getElementById('profileSelect');
const enrollmentCode = document.getElementById('enrollmentCode');
const enrollProfile = document.getElementById('enrollProfile');
const profileMessage = document.getElementById('profileMessage');

function setStep(active) {
  document.querySelectorAll('.step').forEach((element) => {
    const step = Number(element.dataset.step);
    element.classList.toggle('active', step === active);
    element.classList.toggle('done', step < active);
  });
}

async function showProvisioningInfo(status) {
  const info = await window.terrones.provisioning.getInfo();
  recipient.textContent = status.recipient || info.recipient || 'No se encontró la clave pública. Usa Ver diagnóstico.';
}

function render(status) {
  message.textContent = status.message || 'Preparando POS local…';
  detail.textContent = status.error || '';
  const failed = status.state === 'error';
  const needsProvision = status.state === 'needs_provision';
  const provisioning = status.state === 'provisioning';
  const ready = status.state === 'ready_to_open';
  const needsProfile = status.state === 'needs_profile';

  statusBox.classList.toggle('error', failed);
  statusBox.classList.toggle('ready', ready);
  errorActions.hidden = !failed;
  provisionPanel.hidden = !(needsProvision || provisioning);
  profilePanel.hidden = !(needsProfile || needsProvision);
  readyPanel.hidden = !ready;
  importBundle.disabled = provisioning;
  copyRecipient.disabled = provisioning;

  if (needsProfile) {
    setStep(1);
    loadCatalog().catch((error) => { profileMessage.textContent = error.message; });
  } else if (needsProvision || provisioning) {
    setStep(2);
    loadCatalog().catch((error) => { profileMessage.textContent = error.message; });
    showProvisioningInfo(status).catch((error) => { recipient.textContent = error.message; });
  } else if (ready) {
    setStep(3);
  } else {
    setStep(1);
  }
}

async function loadCatalog() {
  const result = await window.terrones.profiles.list();
  profileSelect.replaceChildren(...result.catalog.map((profile) => {
    const option = document.createElement('option'); option.value = profile.id; option.textContent = profile.displayName; return option;
  }));
  if (result.activeProfileId && result.catalog.some((profile) => profile.id === result.activeProfileId)) {
    profileSelect.value = result.activeProfileId;
  }
}

window.terrones.runtime.onStatus(render);
window.terrones.runtime.getStatus().then(render);

copyRecipient.addEventListener('click', async () => {
  await window.terrones.provisioning.copyRecipient();
  copyRecipient.textContent = 'Clave copiada';
  setTimeout(() => { copyRecipient.textContent = 'Copiar clave'; }, 1800);
});

importBundle.addEventListener('click', async () => {
  importBundle.disabled = true;
  const result = await window.terrones.provisioning.selectAndImport();
  if (result?.canceled) importBundle.disabled = false;
});

openPos.addEventListener('click', () => window.terrones.runtime.openPos());
retry.addEventListener('click', async () => { retry.disabled = true; await window.terrones.runtime.retry(); retry.disabled = false; });
diagnostics.addEventListener('click', async () => {
  output.style.display = 'block';
  output.textContent = JSON.stringify(await window.terrones.runtime.getDiagnostics(), null, 2);
});
enrollProfile.addEventListener('click', async () => {
  if (!enrollmentCode.value.trim()) { profileMessage.textContent = 'Escribe el código generado en el VPS.'; return; }
  enrollProfile.disabled = true;
  profileMessage.textContent = 'Configurando la tienda…';
  try { await window.terrones.profiles.enroll(profileSelect.value, enrollmentCode.value.trim()); }
  catch (error) { profileMessage.textContent = error.message; enrollProfile.disabled = false; }
});
