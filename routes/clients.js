const express = require('express');
const multer = require('multer');

const {
  listClients,
  getClient,
  getClientBySubdomain,
  createDraftClient,
  isValidSubdomain,
  normalizeSubdomain,
} = require('../lib/clients');
const { listPlansPublic, defaultPriceForPlan } = require('../lib/plans');
const { containerExistsForSubdomain } = require('../lib/docker');
const {
  provision,
  listLogs,
  STEPS,
  getProvisionStatus,
  getResumeStep,
} = require('../lib/provision');
const { checklistForSubdomain } = require('../lib/postProvisionChecklist');
const { archiveClient } = require('../lib/decommission');
const { writeAudit } = require('../lib/audit');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ok = /image\/(png|jpeg|jpg|svg\+xml)/i.test(file.mimetype)
      || /\.(png|jpe?g|svg)$/i.test(file.originalname || '');
    if (!ok) {
      return cb(new Error('Μόνο png, jpg ή svg (μέχρι 2MB).'));
    }
    return cb(null, true);
  },
});

function requireConfirmSubdomain(expected, provided) {
  return String(provided || '').trim().toLowerCase() === String(expected || '').trim().toLowerCase();
}

router.get('/plans', (_req, res) => {
  res.json({ plans: listPlansPublic() });
});

router.get('/clients', (_req, res) => {
  res.json({ clients: listClients() });
});

router.get('/clients/:id/status', (req, res) => {
  const status = getProvisionStatus(req.params.id);
  if (!status) return res.status(404).json({ error: 'Ο πελάτης δεν βρέθηκε.' });
  const subdomain = status.client.subdomain;
  res.json({
    ...status,
    adminUrl: `https://${subdomain}.kollekta.gr/admin`,
    checklist: checklistForSubdomain(subdomain),
  });
});

router.get('/clients/:id', (req, res) => {
  const client = getClient(req.params.id);
  if (!client) return res.status(404).json({ error: 'Ο πελάτης δεν βρέθηκε.' });
  res.json({
    client,
    logs: listLogs(client.id),
    steps: STEPS,
    resumeStep: getResumeStep(client.id),
    adminUrl: `https://${client.subdomain}.kollekta.gr/admin`,
    checklist: checklistForSubdomain(client.subdomain),
  });
});

router.get('/subdomains/:subdomain/availability', async (req, res) => {
  const subdomain = normalizeSubdomain(req.params.subdomain);
  if (!isValidSubdomain(subdomain)) {
    return res.json({
      subdomain,
      available: false,
      reason: 'invalid',
      message: 'Μη έγκυρη μορφή (^[a-z][a-z0-9-]{1,30}$).',
    });
  }

  const row = getClientBySubdomain(subdomain);
  if (row) {
    return res.json({
      subdomain,
      available: false,
      reason: 'clients',
      message: `Το subdomain χρησιμοποιείται ήδη (${row.status}).`,
    });
  }

  const docker = await containerExistsForSubdomain(subdomain);
  if (docker.exists) {
    return res.json({
      subdomain,
      available: false,
      reason: 'container',
      message: `Υπάρχει ήδη container ${docker.name}.`,
    });
  }

  return res.json({
    subdomain,
    available: true,
    reason: null,
    message: docker.checked ? 'Διαθέσιμο.' : 'Διαθέσιμο (Docker δεν ελέγχθηκε).',
    dockerChecked: docker.checked,
  });
});

router.post('/clients', (req, res) => {
  upload.single('logo')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Αποτυχία ανεβάσματος.' });
    }

    try {
      const subdomain = normalizeSubdomain(req.body.subdomain);
      if (!isValidSubdomain(subdomain)) {
        return res.status(400).json({ error: 'Μη έγκυρο subdomain.' });
      }
      if (!requireConfirmSubdomain(subdomain, req.body.confirm_subdomain)) {
        return res.status(400).json({
          error: 'Πληκτρολόγησε ξανά το subdomain για επιβεβαίωση πριν το provisioning.',
        });
      }
      if (getClientBySubdomain(subdomain)) {
        return res.status(409).json({ error: 'Το subdomain χρησιμοποιείται ήδη.' });
      }
      const docker = await containerExistsForSubdomain(subdomain);
      if (docker.exists) {
        return res.status(409).json({ error: `Υπάρχει ήδη container ${docker.name}.` });
      }

      const client = createDraftClient({
        business_name: req.body.business_name,
        subdomain,
        plan: req.body.plan,
        contact_name: req.body.contact_name,
        contact_email: req.body.contact_email,
        contact_phone: req.body.contact_phone,
        annual_price_eur: req.body.annual_price_eur,
        discount_note: req.body.discount_note,
      });

      writeAudit({
        action: 'client.create',
        clientId: client.id,
        subdomain: client.subdomain,
        detail: `plan=${client.plan}`,
        ip: req.ip || null,
      });

      const logo = req.file
        ? { buffer: req.file.buffer, originalname: req.file.originalname }
        : null;

      res.status(202).json({
        ok: true,
        client,
        steps: STEPS,
        defaultPriceEur: defaultPriceForPlan(client.plan),
      });

      setImmediate(() => {
        provision(client.id, {
          logo,
          confirmSubdomain: subdomain,
          ip: req.ip || null,
        }).catch((provisionErr) => {
          console.error('[provision]', client.id, provisionErr);
        });
      });
    } catch (error) {
      const message = error && error.message ? error.message : 'Αποτυχία δημιουργίας.';
      const status = /χρησιμοποιείται|υπάρχει/i.test(message) ? 409 : 400;
      return res.status(status).json({ error: message });
    }
  });
});

router.post('/clients/:id/retry', async (req, res) => {
  try {
    const client = getClient(req.params.id);
    if (!client) return res.status(404).json({ error: 'Ο πελάτης δεν βρέθηκε.' });
    if (client.status !== 'failed') {
      return res.status(400).json({ error: 'Το retry επιτρέπεται μόνο για status=failed.' });
    }
    if (!requireConfirmSubdomain(client.subdomain, req.body.confirm_subdomain)) {
      return res.status(400).json({ error: 'Πληκτρολόγησε ξανά το subdomain για επιβεβαίωση.' });
    }

    const resumeStep = getResumeStep(client.id);
    res.status(202).json({
      ok: true,
      client,
      resumeStep,
      steps: STEPS,
    });

    setImmediate(() => {
      provision(client.id, {
        resume: true,
        confirmSubdomain: client.subdomain,
        ip: req.ip || null,
      }).catch((provisionErr) => {
        console.error('[provision.retry]', client.id, provisionErr);
      });
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Αποτυχία retry.' });
  }
});

router.post('/clients/:id/archive', async (req, res) => {
  try {
    const result = await archiveClient(req.params.id, {
      confirmSubdomain: req.body.confirm_subdomain,
      exportAck: Boolean(req.body.export_ack),
      ip: req.ip || null,
    });
    res.json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Αποτυχία αρχειοθέτησης.' });
  }
});

module.exports = router;
