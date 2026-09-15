const db = require('../db');
const { isValidPlan, defaultPriceForPlan } = require('./plans');

/** Host ports for customer instances — same rule as legacy M4 / portManager. */
const BASE_PORT = 3100;

const STATUSES = new Set(['draft', 'provisioning', 'active', 'failed', 'archived']);

/** Subdomain: starts with a letter, then 1–30 of [a-z0-9-]. */
const SUBDOMAIN_RE = /^[a-z][a-z0-9-]{1,30}$/;

function normalizeSubdomain(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidSubdomain(value) {
  return SUBDOMAIN_RE.test(normalizeSubdomain(value));
}

function listClients() {
  return db
    .prepare(
      `SELECT * FROM clients
       ORDER BY datetime(created_at) DESC, id DESC`
    )
    .all();
}

function getClient(id) {
  const num = Number(id);
  if (!Number.isInteger(num) || num < 1) return null;
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(num) || null;
}

function getClientBySubdomain(subdomain) {
  const normalized = normalizeSubdomain(subdomain);
  if (!normalized) return null;
  return db.prepare('SELECT * FROM clients WHERE subdomain = ?').get(normalized) || null;
}

/**
 * Insert a draft client. annual_price_eur defaults from the plan when omitted.
 */
function createDraftClient(data = {}) {
  const businessName = String(data.business_name || data.businessName || '').trim();
  const subdomain = normalizeSubdomain(data.subdomain);
  const plan = String(data.plan || '').trim().toLowerCase();

  if (!businessName) {
    throw new Error('Η επωνυμία είναι υποχρεωτική.');
  }
  if (!isValidSubdomain(subdomain)) {
    throw new Error('Μη έγκυρο subdomain (^[a-z][a-z0-9-]{1,30}$).');
  }
  if (!isValidPlan(plan)) {
    throw new Error('Μη έγκυρο plan (basic | pro | business | demo).');
  }

  const existing = getClientBySubdomain(subdomain);
  if (existing) {
    throw new Error(`Το subdomain "${subdomain}" χρησιμοποιείται ήδη.`);
  }

  const priceProvided =
    data.annual_price_eur !== undefined && data.annual_price_eur !== null && data.annual_price_eur !== ''
      ? Number(data.annual_price_eur)
      : data.annualPriceEur !== undefined && data.annualPriceEur !== null && data.annualPriceEur !== ''
        ? Number(data.annualPriceEur)
        : null;

  const annualPriceEur =
    priceProvided !== null && Number.isFinite(priceProvided)
      ? Math.round(priceProvided)
      : defaultPriceForPlan(plan);

  const result = db
    .prepare(
      `INSERT INTO clients (
         business_name, subdomain, plan,
         contact_name, contact_email, contact_phone,
         annual_price_eur, discount_note, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')`
    )
    .run(
      businessName,
      subdomain,
      plan,
      String(data.contact_name || data.contactName || '').trim() || null,
      String(data.contact_email || data.contactEmail || '').trim() || null,
      String(data.contact_phone || data.contactPhone || '').trim() || null,
      annualPriceEur,
      String(data.discount_note || data.discountNote || '').trim() || null
    );

  return getClient(result.lastInsertRowid);
}

function updateClientStatus(id, status, error) {
  const normalized = String(status || '').trim().toLowerCase();
  if (!STATUSES.has(normalized)) {
    throw new Error(`Μη έγκυρο status (${[...STATUSES].join(' | ')}).`);
  }

  const client = getClient(id);
  if (!client) return null;

  if (normalized === 'failed') {
    db.prepare(
      `UPDATE clients
       SET status = ?, provision_error = ?
       WHERE id = ?`
    ).run(normalized, error != null && error !== '' ? String(error) : null, client.id);
  } else if (normalized === 'active') {
    db.prepare(
      `UPDATE clients
       SET status = ?,
           provision_error = NULL,
           activated_at = COALESCE(activated_at, datetime('now'))
       WHERE id = ?`
    ).run(normalized, client.id);
  } else {
    db.prepare(
      `UPDATE clients
       SET status = ?, provision_error = NULL
       WHERE id = ?`
    ).run(normalized, client.id);
  }

  return getClient(client.id);
}

function updateClientPlan(id, { plan, annual_price_eur, discount_note } = {}) {
  const client = getClient(id);
  if (!client) return null;

  const nextPlan = String(plan || '').trim().toLowerCase();
  if (!isValidPlan(nextPlan)) {
    throw new Error('Μη έγκυρο plan (basic | pro | business | demo).');
  }

  const price = Number(annual_price_eur);
  if (!Number.isFinite(price)) {
    throw new Error('Μη έγκυρο ετήσιο τίμημα.');
  }

  const note =
    discount_note !== undefined && discount_note !== null
      ? String(discount_note).trim() || null
      : null;

  db.prepare(
    `UPDATE clients
     SET plan = ?,
         annual_price_eur = ?,
         discount_note = ?
     WHERE id = ?`
  ).run(nextPlan, Math.round(price), note, client.id);

  return getClient(client.id);
}

module.exports = {
  BASE_PORT,
  STATUSES,
  SUBDOMAIN_RE,
  listClients,
  getClient,
  getClientBySubdomain,
  createDraftClient,
  updateClientStatus,
  updateClientPlan,
  normalizeSubdomain,
  isValidSubdomain,
};
