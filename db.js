const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Meta-admin registry (clients + auth). Not a per-customer app.db.
const db = new Database(path.join(dataDir, 'meta.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS auth_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT,
    ip TEXT,
    kind TEXT NOT NULL,
    success INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_auth_attempts_ip ON auth_attempts(ip, kind, created_at);

  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_name TEXT NOT NULL,
    subdomain TEXT NOT NULL UNIQUE,
    plan TEXT NOT NULL,
    contact_name TEXT,
    contact_email TEXT,
    contact_phone TEXT,
    annual_price_eur INTEGER,
    discount_note TEXT,
    port INTEGER UNIQUE,
    status TEXT NOT NULL DEFAULT 'draft',
    provision_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    activated_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);
  CREATE INDEX IF NOT EXISTS idx_clients_subdomain ON clients(subdomain);

  CREATE TABLE IF NOT EXISTS provisioning_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER REFERENCES clients(id),
    step TEXT,
    status TEXT,
    detail TEXT,
    at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_provisioning_log_client ON provisioning_log(client_id, at);

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL DEFAULT 'owner',
    action TEXT NOT NULL,
    client_id INTEGER,
    subdomain TEXT,
    detail TEXT,
    ip TEXT,
    at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at);
  CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, at);
`);

/**
 * Instance 1 (moutaki) was created by hand — seed so it appears in the list
 * and blocks subdomain reuse. Plan/quota from Product-imageshare .env.example
 * / known prod packaging (PLAN=basic, QUOTA_GB=10, port 3100).
 */
function seedMoutaki() {
  const existing = db.prepare(`SELECT id FROM clients WHERE subdomain = 'moutaki'`).get();
  if (existing) return;

  db.prepare(
    `INSERT INTO clients (
       business_name, subdomain, plan,
       contact_name, contact_email, contact_phone,
       annual_price_eur, discount_note, port, status, activated_at
     ) VALUES (
       'Moutaki', 'moutaki', 'basic',
       NULL, NULL, NULL,
       300, NULL, 3100, 'active', datetime('now')
     )`
  ).run();
}

seedMoutaki();

// Keep seeded moutaki list price aligned with current Basic package price
// when no negotiated discount_note is set.
db.prepare(
  `UPDATE clients
   SET annual_price_eur = 300
   WHERE subdomain = 'moutaki' AND plan = 'basic'
     AND (discount_note IS NULL OR discount_note = '')`
).run();

module.exports = db;
