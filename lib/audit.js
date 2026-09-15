const db = require('../db');

const DEFAULT_ACTOR = 'owner';

function writeAudit({
  actor = DEFAULT_ACTOR,
  action,
  clientId = null,
  subdomain = null,
  detail = null,
  ip = null,
} = {}) {
  if (!action) throw new Error('audit action is required');
  db.prepare(
    `INSERT INTO audit_log (actor, action, client_id, subdomain, detail, ip)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    actor || DEFAULT_ACTOR,
    String(action),
    clientId != null ? Number(clientId) : null,
    subdomain || null,
    detail != null ? String(detail) : null,
    ip || null
  );
}

function listAudit({ limit = 100 } = {}) {
  const n = Math.min(500, Math.max(1, Number(limit) || 100));
  return db
    .prepare(
      `SELECT * FROM audit_log
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(n);
}

module.exports = {
  DEFAULT_ACTOR,
  writeAudit,
  listAudit,
};
