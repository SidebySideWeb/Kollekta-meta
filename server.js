const crypto = require('crypto');
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { checkAdminLoginAllowed, recordAttempt, cleanupOldAttempts } = require('./lib/rateLimit');
require('./db'); // schema + moutaki seed
const clientsRoutes = require('./routes/clients');
const { writeAudit } = require('./lib/audit');

const app = express();
const publicDir = path.join(__dirname, 'public');

const SESSION_COOKIE = 'ma_session';
const SESSION_VALUE = '1';
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Hard rule: meta-admin is loopback-only. Never expose on 0.0.0.0. */
const BIND_HOST = '127.0.0.1';
const BIND_PORT = 4000;

if (config.HOST !== BIND_HOST) {
  throw new Error(
    `Meta-admin must bind to ${BIND_HOST} only (got HOST=${config.HOST}). Refusing to start.`
  );
}

if (Number(config.PORT) !== BIND_PORT) {
  throw new Error(
    `Meta-admin must listen on port ${BIND_PORT} only (got PORT=${config.PORT}). Refusing to start.`
  );
}

function requestIsHttps(req) {
  if (process.env.NODE_ENV === 'production') return true;
  const proto = String(req.get('x-forwarded-proto') || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return proto === 'https';
}

function sessionCookieOptions(req) {
  return {
    httpOnly: true,
    signed: true,
    sameSite: 'strict',
    secure: requestIsHttps(req),
    maxAge: SESSION_MAX_AGE_MS,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Constant-time password compare. Never use === for secrets.
 * When lengths differ, still run timingSafeEqual on equal-length digests
 * so length is not leaked via early return alone.
 */
function passwordsMatch(provided, expected) {
  const a = crypto.createHash('sha256').update(String(provided ?? ''), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(expected ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function isAuthenticated(req) {
  return req.signedCookies[SESSION_COOKIE] === SESSION_VALUE;
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  if (req.path.startsWith('/api/') || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ error: 'Απαιτείται σύνδεση.' });
  }
  return res.redirect('/login.html');
}

app.set('trust proxy', true);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(config.META_SESSION_SECRET));

// Public: login page + static assets (css/js under /public)
app.get('/login.html', (_req, res) => {
  res.sendFile(path.join(publicDir, 'login.html'));
});

app.post('/login', async (req, res) => {
  const ip = req.ip || '';
  const limit = checkAdminLoginAllowed(ip);
  if (!limit.allowed) {
    return res.status(429).json({
      error: 'Πολλές προσπάθειες. Δοκίμασε ξανά αργότερα.',
    });
  }

  const password = String(req.body.password || '');
  if (!config.META_ADMIN_PASSWORD) {
    await sleep(300);
    return res.status(503).json({ error: 'META_ADMIN_PASSWORD δεν έχει οριστεί.' });
  }
  const ok = passwordsMatch(password, config.META_ADMIN_PASSWORD);
  if (!ok) {
    recordAttempt({ ip, kind: 'admin_login', success: false });
    writeAudit({ action: 'login.failed', detail: 'bad password', ip });
    console.warn(`[meta_admin_login] failed ip=${ip}`);
    await sleep(300);
    return res.status(401).json({ error: 'Λάθος κωδικός πρόσβασης.' });
  }

  recordAttempt({ ip, kind: 'admin_login', success: true });
  writeAudit({ action: 'login.success', ip });
  res.cookie(SESSION_COOKIE, SESSION_VALUE, sessionCookieOptions(req));
  res.json({ ok: true });
});

app.post('/logout', (req, res) => {
  writeAudit({ action: 'logout', ip: req.ip || null });
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions(req));
  res.json({ ok: true });
});

// Static assets (css/js) are public; the shell page itself requires a session.
const publicStatic = express.static(publicDir, { index: false });
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') return next();
  return publicStatic(req, res, next);
});

app.use(requireAuth);

app.get(['/', '/index.html'], (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/api/me', (req, res) => {
  res.json({ ok: true, authenticated: true });
});

app.use('/api', clientsRoutes);

cleanupOldAttempts();
setInterval(cleanupOldAttempts, 60 * 60 * 1000);

const server = app.listen(BIND_PORT, BIND_HOST, () => {
  const addr = server.address();
  const boundHost = addr && typeof addr === 'object' ? addr.address : BIND_HOST;
  if (boundHost !== '127.0.0.1' && boundHost !== '::ffff:127.0.0.1') {
    console.warn(
      `[hardening] WARNING: process is listening on ${boundHost}:${BIND_PORT} — expected 127.0.0.1 only.`
    );
  }
  console.log(`Kollekta Meta-admin: http://${BIND_HOST}:${BIND_PORT}`);
});
