const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const config = require('../config');
const { getClient, updateClientStatus } = require('./clients');
const { containerNameFor } = require('./docker');
const { writeAudit } = require('./audit');

const execFileAsync = promisify(execFile);

function instanceRoot(subdomain) {
  return path.join(config.INSTANCE_DATA_ROOT, subdomain);
}

/**
 * Archive a client (Αποχώρηση):
 * 1. docker stop (not rm)
 * 2. remove nginx vhost + nginx -t && reload
 * 3. leave instance data on disk
 * Port + subdomain stay reserved in clients.
 */
async function archiveClient(clientId, { confirmSubdomain, exportAck, ip } = {}) {
  const client = getClient(clientId);
  if (!client) {
    throw new Error('Ο πελάτης δεν βρέθηκε.');
  }
  if (client.status === 'archived') {
    return { ok: true, client, already: true };
  }
  if (!['active', 'failed', 'provisioning'].includes(client.status)) {
    throw new Error(`Δεν γίνεται αρχειοθέτηση από status=${client.status}.`);
  }

  const expected = String(client.subdomain || '');
  if (String(confirmSubdomain || '').trim().toLowerCase() !== expected) {
    throw new Error('Πληκτρολόγησε σωστά το subdomain για επιβεβαίωση.');
  }
  if (!exportAck) {
    throw new Error('Επιβεβαίωσε ότι έγινε export (kollekta-export) πριν την αρχειοθέτηση.');
  }

  const name = containerNameFor(client.subdomain);
  const notes = [];

  // 1. Stop container — keep recoverable
  try {
    await execFileAsync('docker', ['stop', name], {
      timeout: 60000,
      windowsHide: true,
    });
    notes.push(`docker stop ${name}`);
  } catch (err) {
    const msg = String(err.stderr || err.message || err);
    if (/No such container|No such object/i.test(msg)) {
      notes.push(`docker stop skipped (missing ${name})`);
    } else {
      throw new Error(`docker stop failed: ${msg}`);
    }
  }

  // 2. Remove nginx vhost
  const availablePath = path.join(config.NGINX_SITES_AVAILABLE, `${client.subdomain}.conf`);
  const enabledPath = path.join(config.NGINX_SITES_ENABLED, `${client.subdomain}.conf`);
  let removed = false;
  for (const p of [enabledPath, availablePath]) {
    try {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { force: true });
        removed = true;
      }
    } catch (err) {
      throw new Error(`Failed removing nginx file ${p}: ${err.message}`);
    }
  }
  if (removed) {
    try {
      await execFileAsync('nginx', ['-t'], {
        timeout: 15000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
    } catch (err) {
      const detail = String(err.stderr || err.stdout || err.message || err);
      throw new Error(`nginx -t failed after vhost removal: ${detail}`);
    }
    await execFileAsync('systemctl', ['reload', 'nginx'], {
      timeout: 30000,
      windowsHide: true,
    });
    notes.push('nginx vhost removed + reload');
  } else {
    notes.push('nginx vhost already absent');
  }

  // 3. Data dir left untouched
  const dataRoot = instanceRoot(client.subdomain);
  notes.push(`data left on disk: ${dataRoot}`);

  updateClientStatus(client.id, 'archived');
  writeAudit({
    action: 'client.archive',
    clientId: client.id,
    subdomain: client.subdomain,
    detail: notes.join('; '),
    ip: ip || null,
  });

  return { ok: true, client: getClient(client.id), notes };
}

module.exports = {
  archiveClient,
};
