const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const CONTAINER_PREFIX = 'kollekta_';

function containerNameFor(subdomain) {
  return `${CONTAINER_PREFIX}${String(subdomain || '').trim().toLowerCase()}`;
}

/**
 * True if a container named kollekta_<subdomain> exists (any state).
 * Uses `docker inspect` so we don't require dockerode for availability checks.
 * If Docker is unavailable, returns { exists: false, checked: false }.
 */
async function containerExistsForSubdomain(subdomain) {
  const name = containerNameFor(subdomain);
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(String(subdomain || ''))) {
    return { exists: false, checked: true, name };
  }

  try {
    await execFileAsync('docker', ['inspect', name], {
      timeout: 5000,
      windowsHide: true,
    });
    return { exists: true, checked: true, name };
  } catch (err) {
    const msg = String(err && err.stderr ? err.stderr : err && err.message ? err.message : '');
    if (/No such object|no such container/i.test(msg) || err.code === 1) {
      return { exists: false, checked: true, name };
    }
    // Docker daemon missing / not running
    return { exists: false, checked: false, name };
  }
}

module.exports = {
  CONTAINER_PREFIX,
  containerNameFor,
  containerExistsForSubdomain,
};
