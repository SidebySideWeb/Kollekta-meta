// Same shape as Kollekta Φάση 1 / Βήμα 5 admin login limits:
// 5 failed attempts per IP per 15 minutes, 20 attempts per hour (any outcome).

const db = require('../db');

const ADMIN_LOGIN_MAX_FAILURES = 5;
const ADMIN_LOGIN_FAILURE_WINDOW_MINUTES = 15;
const ADMIN_LOGIN_MAX_ATTEMPTS_PER_HOUR = 20;

function recordAttempt({ ip, kind, success }) {
  db.prepare(
    `INSERT INTO auth_attempts (phone, ip, kind, success)
     VALUES (?, ?, ?, ?)`
  ).run(null, ip || null, kind, success ? 1 : 0);
}

function countRecent(whereClause, params) {
  return db.prepare(`SELECT COUNT(*) AS count FROM auth_attempts WHERE ${whereClause}`).get(...params)
    .count;
}

function checkAdminLoginAllowed(ip) {
  if (process.env.RATE_LIMIT_DISABLED === 'true') {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  const normalizedIp = ip || '';
  const fails = countRecent(
    `ip = ? AND kind = 'admin_login' AND success = 0 AND datetime(created_at) > datetime('now', '-${ADMIN_LOGIN_FAILURE_WINDOW_MINUTES} minutes')`,
    [normalizedIp]
  );
  if (fails >= ADMIN_LOGIN_MAX_FAILURES) {
    return { allowed: false, retryAfterSeconds: ADMIN_LOGIN_FAILURE_WINDOW_MINUTES * 60 };
  }

  const attempts = countRecent(
    "ip = ? AND kind = 'admin_login' AND datetime(created_at) > datetime('now', '-1 hour')",
    [normalizedIp]
  );
  if (attempts >= ADMIN_LOGIN_MAX_ATTEMPTS_PER_HOUR) {
    return { allowed: false, retryAfterSeconds: 60 * 60 };
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

function cleanupOldAttempts() {
  db.prepare("DELETE FROM auth_attempts WHERE datetime(created_at) < datetime('now', '-24 hours')").run();
}

module.exports = {
  recordAttempt,
  checkAdminLoginAllowed,
  cleanupOldAttempts,
};
