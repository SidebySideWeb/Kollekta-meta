const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');

const {
  getClient,
  updateClientPlan,
} = require('./clients');
const {
  isValidPlan,
  planEnvFlags,
  defaultPriceForPlan,
} = require('./plans');
const {
  prodEnvPath,
  resolveContainerImage,
  runCustomerContainer,
  healthcheckPort,
} = require('./provision');
const { containerNameFor } = require('./docker');
const { writeAudit } = require('./audit');

const execFileAsync = promisify(execFile);

/**
 * Line-level find/replace for prod.env keys. Preserves every other line.
 * Missing keys are appended. chmod 600 afterwards.
 */
function patchProdEnvKeys(filePath, updates) {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Δεν βρέθηκε prod.env (${filePath}). Το plan change απαιτεί instance που έχει ήδη provision-αρει σε αυτό το host.`
    );
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const endedWithNewline = /\r?\n$/.test(raw);
  const lines = raw.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const found = new Set();
  const next = lines.map((line) => {
    if (!line || line.trimStart().startsWith('#')) return line;
    const eq = line.indexOf('=');
    if (eq < 0) return line;
    const key = line.slice(0, eq);
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      found.add(key);
      return `${key}=${updates[key] == null ? '' : String(updates[key])}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!found.has(key)) {
      next.push(`${key}=${value == null ? '' : String(value)}`);
    }
  }

  const body = `${next.join('\n')}${endedWithNewline || next.length ? '\n' : ''}`;
  fs.writeFileSync(filePath, body, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows may ignore mode
  }
}

/** Snapshot selected keys so we can roll back if docker redeploy fails. */
function readEnvKeys(filePath, keys) {
  const out = {};
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    if (keys.includes(key)) out[key] = line.slice(eq + 1);
  }
  return out;
}

function formatDockerError(err) {
  const raw = err && err.message ? err.message : String(err);
  if (/dockerDesktopLinuxEngine|cannot find the file specified|Is the docker daemon running|Cannot connect to the Docker daemon/i.test(raw)) {
    return (
      'Το Docker δεν τρέχει ή δεν είναι προσβάσιμο σε αυτό το host. ' +
      'Το meta-admin πρέπει να τρέχει στο ίδιο μηχάνημα με τα customer containers (όχι μόνο στο laptop). ' +
      `Λεπτομέρεια: ${raw}`
    );
  }
  return raw;
}

async function assertDockerReachable() {
  try {
    await execFileAsync('docker', ['info'], {
      timeout: 10000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(formatDockerError(err));
  }
}

/**
 * Upgrade/downgrade an active client's plan: patch prod.env, redeploy the
 * same image on the same port, healthcheck, then sync DB + audit.
 */
async function applyPlanChange(
  clientId,
  {
    plan,
    annualPriceEur,
    discountNote,
    confirmSubdomain,
    ip,
  } = {}
) {
  const client = getClient(clientId);
  if (!client) throw new Error('Ο πελάτης δεν βρέθηκε.');
  if (client.status !== 'active') {
    throw new Error('Η αλλαγή πακέτου επιτρέπεται μόνο για status=active.');
  }
  if (String(confirmSubdomain || '').trim().toLowerCase() !== client.subdomain) {
    throw new Error('Πληκτρολόγησε σωστά το subdomain για επιβεβαίωση.');
  }
  if (client.port == null) {
    throw new Error('Ο πελάτης δεν έχει δεσμευμένο port.');
  }

  const newPlan = String(plan || '').trim().toLowerCase();
  if (!isValidPlan(newPlan)) {
    throw new Error('Μη έγκυρο plan (basic | pro | business | demo).');
  }

  const flags = planEnvFlags(newPlan);
  if (!flags) throw new Error(`Άγνωστο plan: ${newPlan}`);

  // Line-level updates only — never wholesale rewrite.
  // PLAN + QUOTA_GB as specified; also plan packaging FEATURE_* / retention
  // so upgrades actually take effect (those were written at first provision).
  // Do NOT touch STORAGE_WARN/CRITICAL, secrets, SMTP, EMAIL_*.
  const updates = {
    PLAN: flags.PLAN,
    QUOTA_GB: flags.QUOTA_GB,
    DEFAULT_RETENTION_MONTHS: flags.DEFAULT_RETENTION_MONTHS,
    FEATURE_PRODUCT_CODES: flags.FEATURE_PRODUCT_CODES,
    FEATURE_ORDER_FILTERING: flags.FEATURE_ORDER_FILTERING,
    FEATURE_TAGS: flags.FEATURE_TAGS,
    FEATURE_RETENTION_OVERRIDE: flags.FEATURE_RETENTION_OVERRIDE,
  };

  let price =
    annualPriceEur !== undefined && annualPriceEur !== null && annualPriceEur !== ''
      ? Number(annualPriceEur)
      : defaultPriceForPlan(newPlan);
  if (!Number.isFinite(price)) {
    throw new Error('Μη έγκυρο ετήσιο τίμημα.');
  }
  price = Math.round(price);

  const note =
    discountNote !== undefined && discountNote !== null
      ? String(discountNote).trim() || null
      : client.discount_note;

  const oldPlan = client.plan;
  const oldPrice = client.annual_price_eur;
  const envPath = prodEnvPath(client.subdomain);
  const name = containerNameFor(client.subdomain);

  if (!fs.existsSync(envPath)) {
    throw new Error(
      `Δεν βρέθηκε prod.env για τον πελάτη «${client.subdomain}» (${envPath}). ` +
        'Το seeded/χειροκίνητο status=active χωρίς πραγματικό instance δεν υποστηρίζει αλλαγή πακέτου.'
    );
  }

  // Fail before touching env if Docker is down (avoids DB/env drift vs running container).
  await assertDockerReachable();

  const previousKeys = readEnvKeys(envPath, Object.keys(updates));
  const image = await resolveContainerImage(name);

  patchProdEnvKeys(envPath, updates);

  let containerUp = false;
  let runDetail = null;
  let healthDetail = null;
  let containerError = null;

  try {
    const result = await runCustomerContainer({
      subdomain: client.subdomain,
      port: client.port,
      image,
    });
    containerUp = true;
    runDetail = result.detail;
  } catch (err) {
    containerError = formatDockerError(err);
  }

  if (!containerUp) {
    // Roll back env so disk matches the still-running (or stopped) old container.
    try {
      if (Object.keys(previousKeys).length) {
        patchProdEnvKeys(envPath, previousKeys);
      }
    } catch (rollbackErr) {
      containerError += ` | rollback prod.env failed: ${rollbackErr.message || rollbackErr}`;
    }

    writeAudit({
      action: 'plan.change.failed',
      clientId: client.id,
      subdomain: client.subdomain,
      detail: `${oldPlan}@${oldPrice} → ${newPlan}@${price}; docker: ${containerError}`,
      ip: ip || null,
    });
    throw new Error(containerError || 'Αποτυχία επανεκκίνησης container.');
  }

  // Container is on the new env — DB must match (even if healthcheck later fails).
  updateClientPlan(client.id, {
    plan: newPlan,
    annual_price_eur: price,
    discount_note: note,
  });

  try {
    healthDetail = await healthcheckPort(client.port);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    writeAudit({
      action: 'plan.change.health_failed',
      clientId: client.id,
      subdomain: client.subdomain,
      detail: `${oldPlan}@${oldPrice} → ${newPlan}@${price}; ${message}`,
      ip: ip || null,
    });
    throw new Error(message);
  }

  writeAudit({
    action: 'plan.change',
    clientId: client.id,
    subdomain: client.subdomain,
    detail: `${oldPlan}@${oldPrice} → ${newPlan}@${price}`,
    ip: ip || null,
  });

  return {
    ok: true,
    client: getClient(client.id),
    oldPlan,
    oldPrice,
    newPlan,
    newPrice: price,
    image,
    runDetail,
    healthDetail,
  };
}

function canChangePlan(client) {
  if (!client || client.status !== 'active' || client.port == null) {
    return { ok: false, reason: 'Μόνο ενεργοί πελάτες με port μπορούν να αλλάξουν πακέτο.' };
  }
  const envPath = prodEnvPath(client.subdomain);
  if (!fs.existsSync(envPath)) {
    return {
      ok: false,
      reason: `Λείπει το prod.env (${envPath}) — το instance δεν φαίνεται provision-αρισμένο σε αυτό το host.`,
    };
  }
  return { ok: true, reason: null, envPath };
}

module.exports = {
  patchProdEnvKeys,
  applyPlanChange,
  canChangePlan,
};
