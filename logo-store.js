const fs = require('fs');
const path = require('path');

const DEFAULT_LEGACY_KEYS = ['tunkitos.terrones'];

function storeKey(selectedURL) {
  try {
    const parsed = new URL(selectedURL);
    return `${parsed.hostname}-${parsed.port || 'default'}`.replace(/[^A-Za-z0-9_.-]/g, '_');
  } catch (_) {
    return 'terrones-pos-local';
  }
}

function isValidImage(data) {
  if (!data || data.length < 4) return false;
  const signatures = [
    [0xff, 0xd8, 0xff],
    [0x89, 0x50, 0x4e, 0x47],
    [0x47, 0x49, 0x46, 0x38],
    [0x42, 0x4d],
  ];
  if (signatures.some((signature) => signature.every((byte, index) => data[index] === byte))) return true;
  return data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP';
}

function validImageFile(file) {
  try {
    return fs.statSync(file).isFile() && isValidImage(fs.readFileSync(file));
  } catch (_) {
    return false;
  }
}

function findLegacyLogo(imageDirectory, targetPath, preferredKeys = DEFAULT_LEGACY_KEYS) {
  if (!fs.existsSync(imageDirectory)) return null;
  const entries = fs.readdirSync(imageDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(png|jpe?g|gif|bmp|webp)$/i.test(entry.name))
    .map((entry) => path.join(imageDirectory, entry.name))
    .filter((candidate) => path.resolve(candidate) !== path.resolve(targetPath))
    .filter(validImageFile);

  for (const key of preferredKeys) {
    const preferred = entries.find((candidate) => path.parse(candidate).name.toLowerCase() === String(key).toLowerCase());
    if (preferred) return preferred;
  }
  return entries.length === 1 ? entries[0] : null;
}

function resolveStoredLogo(userDataPath, selectedURL, options = {}) {
  const imageDirectory = path.join(userDataPath, 'images');
  const targetPath = path.join(imageDirectory, `${storeKey(selectedURL)}.png`);
  if (validImageFile(targetPath)) return { path: targetPath, migratedFrom: null };
  if (fs.existsSync(targetPath)) return { path: null, migratedFrom: null };

  const legacyPath = findLegacyLogo(imageDirectory, targetPath, options.preferredKeys || DEFAULT_LEGACY_KEYS);
  if (!legacyPath) return { path: null, migratedFrom: null };

  fs.mkdirSync(imageDirectory, { recursive: true });
  const temporaryPath = `${targetPath}.migrating-${process.pid}`;
  try {
    fs.copyFileSync(legacyPath, temporaryPath, fs.constants.COPYFILE_EXCL);
    fs.renameSync(temporaryPath, targetPath);
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch (_) {}
    throw error;
  }
  return { path: targetPath, migratedFrom: legacyPath };
}

module.exports = { findLegacyLogo, isValidImage, resolveStoredLogo, storeKey };
