const fs = require('fs');
const path = require('path');

// Load local .env (overrides existing env so edits take effect on restart).
function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    process.env[key] = value;
  }
}

loadEnvFile();

const META_ADMIN_PASSWORD = String(process.env.META_ADMIN_PASSWORD || '');
const META_SESSION_SECRET = String(process.env.META_SESSION_SECRET || '');
const HOST = String(process.env.HOST || '127.0.0.1').trim();
const PORT = Number(process.env.PORT) || 4000;

if (!META_ADMIN_PASSWORD) {
  console.error('Σφάλμα: Η μεταβλητή META_ADMIN_PASSWORD είναι υποχρεωτική.');
  process.exit(1);
}

if (!META_SESSION_SECRET) {
  console.error('Σφάλμα: Η μεταβλητή META_SESSION_SECRET είναι υποχρεωτική.');
  process.exit(1);
}

module.exports = {
  META_ADMIN_PASSWORD,
  META_SESSION_SECRET,
  HOST,
  PORT,
};
