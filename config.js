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

/** Instance data root — production default matches Μέρος Α. */
const INSTANCE_DATA_ROOT = path.resolve(
  String(process.env.INSTANCE_DATA_ROOT || '/srv/kollekta/instances')
);

const KOLLEKTA_IMAGE = String(process.env.KOLLEKTA_IMAGE || 'kollekta:latest').trim();

const NGINX_SITES_AVAILABLE = String(
  process.env.NGINX_SITES_AVAILABLE || '/etc/nginx/sites-available'
).trim();
const NGINX_SITES_ENABLED = String(
  process.env.NGINX_SITES_ENABLED || '/etc/nginx/sites-enabled'
).trim();
const NGINX_SECURITY_SNIPPET = String(
  process.env.NGINX_SECURITY_SNIPPET || '/etc/nginx/snippets/kollekta-security-headers.conf'
).trim();
const SSL_FULLCHAIN = String(
  process.env.SSL_FULLCHAIN || '/etc/letsencrypt/live/kollekta.gr/fullchain.pem'
).trim();
const SSL_PRIVKEY = String(
  process.env.SSL_PRIVKEY || '/etc/letsencrypt/live/kollekta.gr/privkey.pem'
).trim();

/** Shared SMTP account used for every customer instance's prod.env. */
const SMTP_HOST = String(process.env.SMTP_HOST || '').trim();
const SMTP_PORT = String(process.env.SMTP_PORT || '587').trim();
const SMTP_USER = String(process.env.SMTP_USER || '').trim();
const SMTP_PASS = String(process.env.SMTP_PASS || '').trim();

// Soft warnings — do not crash (see startup hardening). Still need a secret for cookies.
if (!META_SESSION_SECRET) {
  console.error('Σφάλμα: Η μεταβλητή META_SESSION_SECRET είναι υποχρεωτική.');
  process.exit(1);
}

if (!META_ADMIN_PASSWORD) {
  console.warn(
    '[hardening] WARNING: META_ADMIN_PASSWORD is unset — logins will fail until it is set.'
  );
} else if (META_ADMIN_PASSWORD.length < 20) {
  console.warn(
    `[hardening] WARNING: META_ADMIN_PASSWORD is only ${META_ADMIN_PASSWORD.length} chars (recommend ≥ 20).`
  );
}

module.exports = {
  META_ADMIN_PASSWORD,
  META_SESSION_SECRET,
  HOST,
  PORT,
  INSTANCE_DATA_ROOT,
  KOLLEKTA_IMAGE,
  NGINX_SITES_AVAILABLE,
  NGINX_SITES_ENABLED,
  NGINX_SECURITY_SNIPPET,
  SSL_FULLCHAIN,
  SSL_PRIVKEY,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
};
