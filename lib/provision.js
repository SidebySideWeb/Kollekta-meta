const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const db = require('../db');
const config = require('../config');
const { getClient, updateClientStatus } = require('./clients');
const { planEnvFlags } = require('./plans');
const { containerNameFor } = require('./docker');
const { writeAudit } = require('./audit');

const execFileAsync = promisify(execFile);

const BASE_PORT = 3100;
const STEPS = ['dirs', 'env', 'nginx', 'container', 'healthcheck'];
const CONTAINER_UID = 1000;
const CONTAINER_GID = 1000;

/** One-shot ADMIN_PASSWORD for M5 — never persisted to DB or logs. */
const pendingAdminPasswords = new Map();

function instanceRoot(subdomain) {
  return path.join(config.INSTANCE_DATA_ROOT, subdomain);
}

function prodEnvPath(subdomain) {
  return path.join(instanceRoot(subdomain), 'prod.env');
}

function appendLog(clientId, step, status, detail) {
  const safe = String(detail || '')
    .replace(/ADMIN_PASSWORD=\S+/gi, 'ADMIN_PASSWORD=(redacted)')
    .replace(/SESSION_COOKIE_SECRET=\S+/gi, 'SESSION_COOKIE_SECRET=(redacted)')
    .replace(/SMTP_PASS=\S+/gi, 'SMTP_PASS=(redacted)');
  db.prepare(
    `INSERT INTO provisioning_log (client_id, step, status, detail)
     VALUES (?, ?, ?, ?)`
  ).run(clientId, step, status, safe || null);
}

function listLogs(clientId) {
  return db
    .prepare(
      `SELECT id, step, status, detail, at
       FROM provisioning_log
       WHERE client_id = ?
       ORDER BY id ASC`
    )
    .all(clientId);
}

/** Last outcome per step — a step is done only if its latest row is ok. */
function getCompletedSteps(clientId) {
  const logs = listLogs(clientId);
  const lastByStep = new Map();
  for (const row of logs) {
    lastByStep.set(row.step, row);
  }
  const completed = new Set();
  for (const step of STEPS) {
    const last = lastByStep.get(step);
    if (last && last.status === 'ok') completed.add(step);
  }
  return completed;
}

/** First step that is not yet ok (for retry resume). */
function getResumeStep(clientId) {
  const completed = getCompletedSteps(clientId);
  return STEPS.find((step) => !completed.has(step)) || null;
}

function takeAdminPasswordOnce(clientId) {
  const id = Number(clientId);
  if (!pendingAdminPasswords.has(id)) return null;
  const value = pendingAdminPasswords.get(id);
  pendingAdminPasswords.delete(id);
  return value;
}

function peekAdminPassword(clientId) {
  return pendingAdminPasswords.get(Number(clientId)) || null;
}

function writeEnvFile(filePath, vars) {
  const body = Object.entries(vars)
    .map(([key, value]) => `${key}=${value == null ? '' : String(value)}`)
    .join('\n');
  fs.writeFileSync(filePath, `${body}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows may ignore mode — best-effort.
  }
}

function chownRecursive(targetPath, uid, gid) {
  const stat = fs.lstatSync(targetPath);
  try {
    fs.chownSync(targetPath, uid, gid);
  } catch (err) {
    if (process.platform === 'win32') return;
    throw err;
  }
  if (!stat.isDirectory()) return;
  for (const name of fs.readdirSync(targetPath)) {
    chownRecursive(path.join(targetPath, name), uid, gid);
  }
}

async function listDockerHostPorts() {
  const ports = new Set();
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['ps', '-a', '--format', '{{.Ports}}'],
      { timeout: 10000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }
    );
    for (const line of String(stdout || '').split(/\r?\n/)) {
      for (const match of line.matchAll(/\b(\d{4,5})->/g)) {
        const n = Number(match[1]);
        if (Number.isInteger(n) && n > 0) ports.add(n);
      }
    }
  } catch {
    // Docker unavailable — fall back to DB-only allocation.
  }
  return ports;
}

async function assignPort(clientId) {
  const client = getClient(clientId);
  if (!client) {
    throw new Error('Ο πελάτης δεν βρέθηκε.');
  }
  if (client.port != null) {
    return client.port;
  }

  const dbPorts = new Set(
    db
      .prepare('SELECT port FROM clients WHERE port IS NOT NULL')
      .all()
      .map((row) => Number(row.port))
      .filter((n) => Number.isInteger(n) && n > 0)
  );

  const dockerPorts = await listDockerHostPorts();

  const row = db
    .prepare('SELECT MAX(port) AS maxPort FROM clients WHERE port IS NOT NULL')
    .get();
  let candidate = row?.maxPort != null ? Number(row.maxPort) + 1 : BASE_PORT;
  if (!Number.isInteger(candidate) || candidate < BASE_PORT) {
    candidate = BASE_PORT;
  }

  while (dbPorts.has(candidate) || dockerPorts.has(candidate)) {
    candidate += 1;
  }

  db.prepare('UPDATE clients SET port = ? WHERE id = ?').run(candidate, client.id);
  return candidate;
}

async function stepDirs(client, ctx) {
  const root = instanceRoot(client.subdomain);
  const dirs = [
    root,
    path.join(root, 'data'),
    path.join(root, 'uploads'),
    path.join(root, 'logo'),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (ctx.logo && ctx.logo.buffer) {
    const safe =
      String(ctx.logo.originalname || 'logo.png')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .slice(0, 80) || 'logo.png';
    fs.writeFileSync(path.join(root, 'logo', safe), ctx.logo.buffer);
    ctx.logoFilename = safe;
  }

  try {
    chownRecursive(root, CONTAINER_UID, CONTAINER_GID);
  } catch (err) {
    try {
      await execFileAsync('chown', ['-R', `${CONTAINER_UID}:${CONTAINER_GID}`, root], {
        timeout: 30000,
        windowsHide: true,
      });
    } catch (chownErr) {
      throw new Error(
        `chown 1000:1000 failed on ${root}: ${chownErr.message || err.message}`
      );
    }
  }

  return `mkdir + chown 1000:1000 ${root}`;
}

async function stepEnv(client, ctx) {
  const envPath = prodEnvPath(client.subdomain);
  // Retry: never regenerate secrets if prod.env already exists from a prior ok/partial write.
  if (ctx.preserveEnv && fs.existsSync(envPath)) {
    ctx.envPath = envPath;
    return `Kept existing prod.env at ${envPath} (no secret regeneration)`;
  }

  const planFlags = planEnvFlags(client.plan);
  if (!planFlags) throw new Error(`Άγνωστο plan: ${client.plan}`);

  const adminPassword = crypto.randomBytes(12).toString('hex');
  const sessionSecret = crypto.randomBytes(32).toString('hex');
  ctx.adminPassword = adminPassword;

  const vars = {
    PORT: '3000',
    COMPANY_NAME: client.business_name,
    COMPANY_PHONE: client.contact_phone || '',
    COMPANY_EMAIL: client.contact_email || '',
    ADMIN_EMAIL: client.contact_email || '',
    ADMIN_PASSWORD: adminPassword,
    SESSION_COOKIE_SECRET: sessionSecret,
    APP_PUBLIC_URL: `https://${client.subdomain}.kollekta.gr`,
    ACCENT_COLOR: '#2563EB',
    LOGO_PATH: ctx.logoFilename ? `/logo/${ctx.logoFilename}` : '/shared/kollekta-lockup.svg',
    EMAIL_PROVIDER: 'smtp',
    EMAIL_FROM: `${client.subdomain}@kollekta.gr`,
    SMTP_HOST: config.SMTP_HOST,
    SMTP_PORT: config.SMTP_PORT,
    SMTP_USER: config.SMTP_USER,
    SMTP_PASS: config.SMTP_PASS,
    SMTP_FROM: `${client.subdomain}@kollekta.gr`,
    MESSAGING_PROVIDER: 'console',
    ...planFlags,
  };

  writeEnvFile(envPath, vars);
  ctx.envPath = envPath;
  return `Wrote prod.env (chmod 600) at ${envPath}`;
}

function renderNginxTemplate(client, port) {
  const tplPath = path.join(__dirname, '..', 'templates', 'nginx-vhost.conf.tpl');
  let tpl = fs.readFileSync(tplPath, 'utf8');
  const replacements = {
    '{{SUBDOMAIN}}': client.subdomain,
    '{{PORT}}': String(port),
    '{{SSL_FULLCHAIN}}': config.SSL_FULLCHAIN,
    '{{SSL_PRIVKEY}}': config.SSL_PRIVKEY,
    '{{SECURITY_SNIPPET}}': config.NGINX_SECURITY_SNIPPET,
  };
  for (const [token, value] of Object.entries(replacements)) {
    tpl = tpl.split(token).join(value);
  }
  return tpl;
}

async function stepNginx(client, ctx) {
  const availablePath = path.join(
    config.NGINX_SITES_AVAILABLE,
    `${client.subdomain}.conf`
  );
  const enabledPath = path.join(
    config.NGINX_SITES_ENABLED,
    `${client.subdomain}.conf`
  );

  fs.mkdirSync(config.NGINX_SITES_AVAILABLE, { recursive: true });
  fs.mkdirSync(config.NGINX_SITES_ENABLED, { recursive: true });

  const conf = renderNginxTemplate(client, ctx.port);
  fs.writeFileSync(availablePath, conf, 'utf8');

  try {
    fs.rmSync(enabledPath, { force: true });
  } catch {
    // ignore
  }
  try {
    fs.symlinkSync(availablePath, enabledPath);
  } catch {
    fs.copyFileSync(availablePath, enabledPath);
  }

  try {
    await execFileAsync('nginx', ['-t'], {
      timeout: 15000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    const detail = String(err.stderr || err.stdout || err.message || err);
    try {
      fs.rmSync(enabledPath, { force: true });
    } catch {
      // ignore
    }
    try {
      fs.rmSync(availablePath, { force: true });
    } catch {
      // ignore
    }
    throw new Error(`nginx -t failed; removed ${client.subdomain}.conf — ${detail}`);
  }

  await execFileAsync('systemctl', ['reload', 'nginx'], {
    timeout: 30000,
    windowsHide: true,
  });

  return `Installed ${availablePath}, nginx -t OK, reloaded`;
}

async function assertLoopbackBinding(containerName, port) {
  const { stdout } = await execFileAsync(
    'docker',
    ['port', containerName, '3000/tcp'],
    { timeout: 10000, windowsHide: true }
  );
  const binding = String(stdout || '').trim();
  if (!binding.includes('127.0.0.1:')) {
    throw new Error(
      `Port binding must be loopback-only (got "${binding || '(empty)'}"). Expected 127.0.0.1:${port}.`
    );
  }
  if (!binding.includes(`127.0.0.1:${port}`)) {
    throw new Error(`Unexpected port binding "${binding}" (wanted 127.0.0.1:${port}).`);
  }
  return binding;
}

/**
 * Inspect the image tag/id the named container is currently using.
 * Falls back to config.KOLLEKTA_IMAGE when the container is missing.
 */
async function resolveContainerImage(containerName) {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['inspect', '-f', '{{.Config.Image}}', containerName],
      { timeout: 10000, windowsHide: true }
    );
    const image = String(stdout || '').trim();
    if (image) return image;
  } catch {
    // missing container — use configured image
  }
  return config.KOLLEKTA_IMAGE;
}

/**
 * Shared docker run used by M4 provision and plan change.
 * Removes any existing container with the same name first.
 */
async function runCustomerContainer({
  subdomain,
  port,
  image,
}) {
  const name = containerNameFor(subdomain);
  const root = instanceRoot(subdomain);
  const envFile = prodEnvPath(subdomain);

  if (!fs.existsSync(envFile)) {
    throw new Error(`Missing prod.env at ${envFile}`);
  }

  try {
    await execFileAsync('docker', ['rm', '-f', name], {
      timeout: 30000,
      windowsHide: true,
    });
  } catch {
    // ignore
  }

  const resolvedImage = image || config.KOLLEKTA_IMAGE;
  const args = [
    'run',
    '-d',
    '--name',
    name,
    '--restart',
    'unless-stopped',
    '-p',
    `127.0.0.1:${port}:3000`,
    '--env-file',
    path.resolve(envFile),
    '-v',
    `${path.resolve(root, 'data')}:/app/data`,
    '-v',
    `${path.resolve(root, 'uploads')}:/app/uploads`,
    '-v',
    `${path.resolve(root, 'logo')}:/app/logo`,
    resolvedImage,
  ];

  let stdout;
  try {
    ({ stdout } = await execFileAsync('docker', args, {
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    }));
  } catch (err) {
    const detail = String(err.stderr || err.stdout || err.message || err);
    throw new Error(`docker run failed: ${detail}`);
  }

  const id = String(stdout || '').trim().slice(0, 12);
  const binding = await assertLoopbackBinding(name, port);
  return {
    containerId: id,
    containerName: name,
    image: resolvedImage,
    binding,
    detail: `Started ${name} (${id || 'ok'}) image=${resolvedImage} bound ${binding}`,
  };
}

async function stepContainer(client, ctx) {
  const result = await runCustomerContainer({
    subdomain: client.subdomain,
    port: ctx.port,
    image: config.KOLLEKTA_IMAGE,
  });
  ctx.containerId = result.containerId;
  return result.detail;
}

async function healthcheckPort(port) {
  const urls = [
    `http://127.0.0.1:${port}/`,
    `http://127.0.0.1:${port}/api/branding`,
  ];
  const deadline = Date.now() + 15000;
  let lastError = 'timeout';

  while (Date.now() < deadline) {
    for (const url of urls) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
        if (res.status < 500) {
          return `Health OK ${url} → HTTP ${res.status}`;
        }
        lastError = `${url} HTTP ${res.status}`;
      } catch (err) {
        lastError = `${url}: ${err.message || String(err)}`;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error(`Healthcheck timed out after 15s — last error: ${lastError}`);
}

async function stepHealthcheck(client, ctx) {
  return healthcheckPort(ctx.port);
}

const STEP_RUNNERS = {
  dirs: stepDirs,
  env: stepEnv,
  nginx: stepNginx,
  container: stepContainer,
  healthcheck: stepHealthcheck,
};

/**
 * @param {object} [options]
 * @param {boolean} [options.resume] — skip steps that already logged ok; keep prod.env secrets
 * @param {string} [options.confirmSubdomain] — must match client.subdomain
 * @param {string} [options.ip]
 * @param {object} [options.logo]
 */
async function provision(clientId, {
  logo,
  onProgress,
  resume = false,
  confirmSubdomain,
  ip,
} = {}) {
  const emit = typeof onProgress === 'function' ? onProgress : () => {};
  let client = getClient(clientId);
  if (!client) throw new Error('Ο πελάτης δεν βρέθηκε.');

  if (String(confirmSubdomain || '').trim().toLowerCase() !== client.subdomain) {
    throw new Error('Πληκτρολόγησε σωστά το subdomain για επιβεβαίωση.');
  }

  const completed = resume ? getCompletedSteps(clientId) : new Set();
  const startStep = resume ? getResumeStep(clientId) : STEPS[0];
  if (resume && !startStep) {
    updateClientStatus(clientId, 'active');
    return { ok: true, client: getClient(clientId), alreadyComplete: true };
  }

  writeAudit({
    action: resume ? 'provision.retry' : 'provision.start',
    clientId: client.id,
    subdomain: client.subdomain,
    detail: resume ? `resume from ${startStep}` : 'from dirs',
    ip: ip || null,
  });

  updateClientStatus(clientId, 'provisioning');

  const port = await assignPort(clientId);
  client = getClient(clientId);

  const ctx = {
    port,
    logo: logo || null,
    logoFilename: null,
    adminPassword: null,
    envPath: null,
    containerId: null,
    // On retry: never rewrite secrets if prod.env already exists.
    preserveEnv: Boolean(resume && fs.existsSync(prodEnvPath(client.subdomain))),
  };

  const startIndex = STEPS.indexOf(startStep || 'dirs');

  for (let i = startIndex; i < STEPS.length; i++) {
    const step = STEPS[i];
    if (completed.has(step)) {
      emit({ step, status: 'ok', detail: 'skipped (already ok)' });
      continue;
    }

    emit({ step, status: 'running', detail: null });
    try {
      const detail = await STEP_RUNNERS[step](client, ctx);
      appendLog(clientId, step, 'ok', detail);
      emit({ step, status: 'ok', detail });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      appendLog(clientId, step, 'failed', message);
      emit({ step, status: 'failed', detail: message });
      updateClientStatus(clientId, 'failed', `${step}: ${message}`);
      writeAudit({
        action: 'provision.failed',
        clientId: client.id,
        subdomain: client.subdomain,
        detail: `${step}: ${message}`,
        ip: ip || null,
      });
      return {
        ok: false,
        client: getClient(clientId),
        failedStep: step,
        error: message,
        port,
      };
    }
  }

  updateClientStatus(clientId, 'active');
  if (ctx.adminPassword) {
    pendingAdminPasswords.set(Number(clientId), ctx.adminPassword);
  }

  writeAudit({
    action: 'provision.success',
    clientId: client.id,
    subdomain: client.subdomain,
    detail: `port=${port}`,
    ip: ip || null,
  });

  return {
    ok: true,
    client: getClient(clientId),
    adminPassword: ctx.adminPassword || null,
    port,
  };
}

async function provisionClient(clientId, options) {
  return provision(clientId, options);
}

function getProvisionStatus(clientId) {
  const client = getClient(clientId);
  if (!client) return null;

  const logs = listLogs(client.id);
  const completed = getCompletedSteps(client.id);
  const resumeStep = getResumeStep(client.id);
  let currentStep = null;
  if (client.status === 'provisioning') {
    currentStep = resumeStep;
  }

  const adminPassword =
    client.status === 'active' ? takeAdminPasswordOnce(client.id) : null;

  return {
    client,
    steps: STEPS,
    logs,
    currentStep,
    failedStep: client.status === 'failed' ? resumeStep : null,
    resumeStep,
    completedSteps: [...completed],
    adminPassword,
  };
}

module.exports = {
  BASE_PORT,
  STEPS,
  assignPort,
  provision,
  provisionClient,
  listLogs,
  instanceRoot,
  prodEnvPath,
  getProvisionStatus,
  getCompletedSteps,
  getResumeStep,
  takeAdminPasswordOnce,
  peekAdminPassword,
  resolveContainerImage,
  runCustomerContainer,
  healthcheckPort,
};
