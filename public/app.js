const SUBDOMAIN_RE = /^[a-z][a-z0-9-]{1,30}$/;
const PROVISION_STEPS = ['dirs', 'env', 'nginx', 'container', 'healthcheck'];
const STEP_LABELS = {
  dirs: 'Φάκελοι',
  env: 'Env',
  nginx: 'Nginx',
  container: 'Container',
  healthcheck: 'Healthcheck',
};

let plansById = {};
let plansOrder = [];
let clientsById = {};
let subdomainTimer = null;
let subdomainOk = false;
let pollTimer = null;
let revealedPassword = '';

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function adminUrl(subdomain) {
  return `https://${subdomain}.kollekta.gr/admin`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    ...options,
  });
  if (res.status === 401) {
    location.href = '/login.html';
    throw new Error('Απαιτείται σύνδεση.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 202) {
    throw new Error(data.error || 'Αποτυχία αιτήματος.');
  }
  return { res, data };
}

function statusLabel(status) {
  const map = {
    draft: 'Draft',
    provisioning: 'Provisioning',
    active: 'Ενεργός',
    failed: 'Αποτυχία',
    archived: 'Αρχειοθετημένος',
  };
  return map[status] || status;
}

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(String(value).includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  return d.toLocaleDateString('el-GR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function showView(name) {
  $('view-list').classList.toggle('hidden', name !== 'list');
  $('view-new').classList.toggle('hidden', name !== 'new');
  $('view-detail').classList.toggle('hidden', name !== 'detail');
}

function fillPlanSelect(selectEl, selectedId) {
  if (!selectEl) return;
  const options = plansOrder.length ? plansOrder : Object.values(plansById);
  if (!options.length) return;
  selectEl.innerHTML = options
    .map(
      (p) =>
        `<option value="${escapeHtml(p.id)}"${p.id === selectedId ? ' selected' : ''}>${escapeHtml(p.label)}</option>`
    )
    .join('');
}

function planBadgeHtml(planId) {
  if (String(planId || '').toLowerCase() !== 'demo') return '';
  return ' <span class="pill plan-demo" title="Εσωτερικό demo / trial">DEMO</span>';
}

function formatPlanCell(planId) {
  const plan = plansById[planId];
  const label = plan ? plan.label : planId;
  return `${escapeHtml(label)}${planBadgeHtml(planId)}`;
}

function formatPriceCell(client) {
  const plan = plansById[client.plan];
  const billable =
    plan && plan.countsTowardRevenue !== undefined
      ? plan.countsTowardRevenue
      : Number(client.annual_price_eur) > 0;
  if (!billable || client.plan === 'demo') {
    return '<span class="muted">—</span>';
  }
  const price = client.annual_price_eur != null ? `${client.annual_price_eur}€` : '—';
  const note = client.discount_note
    ? ` <span class="muted">(${escapeHtml(client.discount_note)})</span>`
    : '';
  return `${price}${note}`;
}

function planPreviewHtml(planId) {
  const plan = plansById[planId];
  if (!plan) return '';
  const retention =
    plan.retentionMonths == null ? 'άπειρο' : `${plan.retentionMonths}`;
  const features = [];
  if (plan.features.productCodes) features.push('κωδικοί');
  if (plan.features.tags) features.push('ετικέτες');
  const featureText = features.length
    ? features.join(', ')
    : 'χωρίς κωδικούς / ετικέτες';

  return `
    <p class="plan-preview-title">${escapeHtml(plan.label)} — προεπισκόπηση</p>
    <ul>
      <li>Χώρος: <strong>${plan.quotaGb} GB</strong></li>
      <li>Retention: <strong>${escapeHtml(retention)} μήνες</strong></li>
      <li>Χαρακτηριστικά: <strong>${escapeHtml(featureText)}</strong></li>
    </ul>
  `;
}

function renderPlanPreview(planId, targetId = 'plan-preview') {
  const el = $(targetId);
  if (!el) return;
  el.innerHTML = planPreviewHtml(planId);
}

function syncPriceFromPlan() {
  const planId = $('plan-select').value;
  const plan = plansById[planId];
  if (!plan) return;
  $('price-input').value = plan.annualPriceEur;
  updateDiscountPreview();
  renderPlanPreview(planId);
}

function syncEditPlanForm() {
  const planId = $('edit-plan-select')?.value;
  const plan = plansById[planId];
  if (!plan) return;
  $('edit-price-input').value = plan.annualPriceEur;
  renderPlanPreview(planId, 'edit-plan-preview');

  const currentGb = Number($('edit-plan-form')?.dataset.currentGb || 0);
  const warn = $('edit-downgrade-warn');
  if (warn) {
    const isDowngrade = plan.quotaGb < currentGb;
    warn.classList.toggle('hidden', !isDowngrade);
  }
}

function updateDiscountPreview() {
  const note = $('discount-note').value.trim();
  const el = $('discount-preview');
  if (!note) {
    el.textContent = 'Προσυμπληρωμένο από το πακέτο — επεξεργάσιμο.';
    return;
  }
  el.textContent = `Έκπτωση: ${note}`;
}

async function checkSubdomain(value) {
  const hint = $('subdomain-hint');
  const input = $('subdomain-input');
  subdomainOk = false;
  input.classList.remove('ok', 'bad');

  if (!value) {
    hint.textContent = 'Μόνο πεζά λατινικά, αριθμοί και παύλα.';
    hint.className = 'field-hint';
    return;
  }
  if (!SUBDOMAIN_RE.test(value)) {
    hint.textContent = 'Μη έγκυρη μορφή (^[a-z][a-z0-9-]{1,30}$).';
    hint.className = 'field-hint bad';
    input.classList.add('bad');
    return;
  }

  hint.textContent = 'Έλεγχος…';
  hint.className = 'field-hint';
  try {
    const { data } = await api(`/api/subdomains/${encodeURIComponent(value)}/availability`);
    if (data.available) {
      subdomainOk = true;
      hint.textContent = data.message || 'Διαθέσιμο.';
      hint.className = 'field-hint ok';
      input.classList.add('ok');
    } else {
      hint.textContent = data.message || 'Μη διαθέσιμο.';
      hint.className = 'field-hint bad';
      input.classList.add('bad');
    }
  } catch (err) {
    hint.textContent = err.message || 'Αποτυχία ελέγχου.';
    hint.className = 'field-hint bad';
    input.classList.add('bad');
  }
}

function renderClients(clients) {
  const empty = $('clients-empty');
  const wrap = $('clients-table-wrap');
  const body = $('clients-body');
  clientsById = {};

  if (!clients.length) {
    empty.classList.remove('hidden');
    wrap.classList.add('hidden');
    body.innerHTML = '';
    return;
  }

  empty.classList.add('hidden');
  wrap.classList.remove('hidden');
  body.innerHTML = clients
    .map((c) => {
      clientsById[c.id] = c;
      const failedInline =
        c.status === 'failed' && c.provision_error
          ? `<div class="row-error">${escapeHtml(c.provision_error)}</div>`
          : '';
      return `<tr class="client-row ${c.status === 'failed' ? 'row-failed' : ''}" data-id="${c.id}" tabindex="0">
        <td>
          <div class="cell-main">${escapeHtml(c.business_name)}</div>
          ${failedInline}
        </td>
        <td><code>${escapeHtml(c.subdomain)}</code></td>
        <td>${formatPlanCell(c.plan)}</td>
        <td><span class="pill status-${escapeHtml(c.status)}">${escapeHtml(statusLabel(c.status))}</span></td>
        <td>${formatPriceCell(c)}</td>
        <td>${escapeHtml(formatDate(c.created_at))}</td>
      </tr>`;
    })
    .join('');
}

async function loadClients() {
  const { data } = await api('/api/clients');
  renderClients(data.clients || []);
}

function resetProvisionPanel() {
  const list = $('provision-steps');
  list.innerHTML = PROVISION_STEPS.map(
    (step) =>
      `<li data-step="${step}" class="step pending">
        <span class="step-dot"></span>
        <span class="step-label">${STEP_LABELS[step] || step}</span>
        <span class="step-detail"></span>
      </li>`
  ).join('');
  $('provision-error').classList.add('hidden');
  $('provision-done-btn').classList.add('hidden');
  $('provision-title').textContent = 'Provisioning…';
  $('provision-subtitle').textContent = 'Μην κλείσεις τη σελίδα και μην ξαναυποβάλεις τη φόρμα.';
  $('provision-panel').querySelector('.spinner')?.classList.remove('hidden');
}

function setStepState(step, status, detail) {
  const li = document.querySelector(`#provision-steps li[data-step="${step}"]`);
  if (!li) return;
  li.className = `step ${status}`;
  const detailEl = li.querySelector('.step-detail');
  if (detailEl) detailEl.textContent = detail || '';
}

function showSuccessReveal({ client, adminPassword, adminUrl: url, checklist }) {
  $('provision-panel').classList.add('hidden');
  $('new-client-form').classList.add('hidden');
  const panel = $('success-panel');
  panel.classList.remove('hidden');

  $('success-title').textContent = `Ο πελάτης ${client.business_name} είναι έτοιμος.`;
  const link = $('success-admin-link');
  const href = url || adminUrl(client.subdomain);
  link.href = href;
  link.textContent = href;

  revealedPassword = adminPassword || '';
  $('success-password').textContent = revealedPassword || '(μη διαθέσιμος — ανανέωσε πριν ολοκληρωθεί το poll)';
  $('copy-password-btn').disabled = !revealedPassword;
  $('copy-password-btn').textContent = 'Αντιγραφή';

  const lines = Array.isArray(checklist) ? checklist : [];
  $('success-checklist').textContent = lines.map((line, i) => `${i + 1}. ${line}`).join('\n');
}

async function pollProvision(clientId) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const { data } = await api(`/api/clients/${clientId}/status`);
      const logs = data.logs || [];
      for (const log of logs) {
        setStepState(log.step, log.status === 'ok' ? 'ok' : 'failed', log.detail || '');
      }
      if (data.currentStep && data.client.status === 'provisioning') {
        setStepState(data.currentStep, 'running', '');
      }

      if (data.client.status === 'active') {
        clearInterval(pollTimer);
        $('provision-panel').querySelector('.spinner')?.classList.add('hidden');
        showSuccessReveal(data);
        await loadClients();
      } else if (data.client.status === 'failed') {
        clearInterval(pollTimer);
        $('provision-title').textContent = 'Αποτυχία provisioning';
        $('provision-panel').querySelector('.spinner')?.classList.add('hidden');
        const err = $('provision-error');
        const step = data.failedStep ? `[${data.failedStep}] ` : '';
        err.textContent = step + (data.client.provision_error || 'Άγνωστο σφάλμα.');
        err.classList.remove('hidden');
        $('provision-done-btn').classList.remove('hidden');
        await loadClients();
      }
    } catch (err) {
      clearInterval(pollTimer);
      const errEl = $('provision-error');
      errEl.textContent = err.message || 'Αποτυχία παρακολούθησης.';
      errEl.classList.remove('hidden');
      $('provision-done-btn').classList.remove('hidden');
      $('provision-panel').querySelector('.spinner')?.classList.add('hidden');
    }
  }, 800);
}

function openNewClient() {
  showView('new');
  $('new-client-form').classList.remove('hidden');
  $('provision-panel').classList.add('hidden');
  $('success-panel').classList.add('hidden');
  $('form-error').classList.add('hidden');
  $('submit-client-btn').disabled = false;
  $('new-client-form').reset();
  subdomainOk = false;
  revealedPassword = '';
  if ($('confirm-subdomain-input')) $('confirm-subdomain-input').value = '';
  $('subdomain-hint').textContent = 'Μόνο πεζά λατινικά, αριθμοί και παύλα.';
  $('subdomain-hint').className = 'field-hint';
  $('subdomain-input').classList.remove('ok', 'bad');
  syncPriceFromPlan();
}

async function openClientDetail(id) {
  showView('detail');
  $('detail-panel').innerHTML = '<p class="muted">Φόρτωση…</p>';
  try {
    const { data } = await api(`/api/clients/${id}`);
    const c = data.client;
    $('detail-title').textContent = c.business_name;
    $('detail-subtitle').textContent = `${c.subdomain} · ${statusLabel(c.status)}`;

    const logsHtml = (data.logs || []).length
      ? `<table class="data-table compact">
          <thead><tr><th>Βήμα</th><th>Κατάσταση</th><th>Λεπτομέρεια</th><th>Ώρα</th></tr></thead>
          <tbody>
            ${data.logs
              .map(
                (log) => `<tr class="${log.status === 'failed' ? 'row-failed' : ''}">
                  <td>${escapeHtml(log.step)}</td>
                  <td>${escapeHtml(log.status)}</td>
                  <td class="log-detail">${escapeHtml(log.detail || '')}</td>
                  <td>${escapeHtml(log.at || '')}</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>`
      : '<p class="muted">Δεν υπάρχει provisioning log.</p>';

    const url = data.adminUrl || adminUrl(c.subdomain);
    const resume = data.resumeStep;
    const retryBtn =
      c.status === 'failed'
        ? `<button type="button" class="btn btn-secondary" data-action="retry" data-id="${c.id}" data-subdomain="${escapeHtml(c.subdomain)}" data-resume="${escapeHtml(resume || '')}">Δοκίμασε ξανά${resume ? ` (από ${escapeHtml(resume)})` : ''}</button>`
        : '';
    const archiveBtn =
      c.status !== 'archived' && c.status !== 'draft'
        ? `<button type="button" class="btn btn-ghost" data-action="archive" data-id="${c.id}" data-subdomain="${escapeHtml(c.subdomain)}">Αρχειοθέτηση πελάτη</button>`
        : '';

    const currentPlan = plansById[c.plan];
    const currentGb = currentPlan ? currentPlan.quotaGb : 0;
    const allowPlanChange = data.canChangePlan !== false && c.status === 'active';
    const editPlanSection =
      c.status === 'active' && allowPlanChange
        ? `<section class="edit-plan-section" id="edit-plan-section">
            <h3>Επεξεργασία πακέτου</h3>
            <form id="edit-plan-form" class="client-form compact" data-id="${c.id}" data-subdomain="${escapeHtml(c.subdomain)}" data-current-gb="${currentGb}">
              <div class="form-grid">
                <label class="field">
                  <span>Πακέτο</span>
                  <select id="edit-plan-select" name="plan" required></select>
                </label>
                <label class="field">
                  <span>Ετήσιο τίμημα (€)</span>
                  <input type="number" name="annual_price_eur" id="edit-price-input" min="0" step="1" value="${c.annual_price_eur != null ? Number(c.annual_price_eur) : ''}">
                </label>
                <label class="field field-span">
                  <span>Σημείωση έκπτωσης</span>
                  <input type="text" name="discount_note" id="edit-discount-note" value="${escapeHtml(c.discount_note || '')}" placeholder="π.χ. -30% lifetime, testimonial">
                </label>
              </div>
              <div class="plan-preview" id="edit-plan-preview" aria-live="polite"></div>
              <p class="warn-banner hidden" id="edit-downgrade-warn" role="alert">
                Το downgrade δεν διαγράφει αυτόματα αρχεία. Αν ο πελάτης έχει ήδη περισσότερα δεδομένα από το νέο όριο, το instance του θα δείξει υπέρβαση quota μέχρι να διαγράψει ο ίδιος περιεχόμενο.
              </p>
              <p id="edit-plan-msg" class="status-line hidden"></p>
              <div class="form-actions">
                <button type="submit" class="btn btn-secondary" id="edit-plan-submit">Εφαρμογή αλλαγής πακέτου</button>
              </div>
            </form>
          </section>`
        : c.status === 'active' && data.planChangeBlockReason
          ? `<section class="edit-plan-section">
              <h3>Επεξεργασία πακέτου</h3>
              <p class="status-line error">${escapeHtml(data.planChangeBlockReason)}</p>
            </section>`
          : '';

    $('detail-panel').innerHTML = `
      <div class="detail-grid">
        <div>
          <h3>Στοιχεία</h3>
          <dl class="detail-dl">
            <dt>Subdomain</dt><dd><code>${escapeHtml(c.subdomain)}</code></dd>
            <dt>Πακέτο</dt><dd>${formatPlanCell(c.plan)}</dd>
            <dt>Port</dt><dd>${c.port != null ? c.port : '—'}</dd>
            <dt>Τίμημα</dt><dd>${formatPriceCell(c)}${
              c.discount_note && c.plan === 'demo'
                ? ` <span class="muted">(${escapeHtml(c.discount_note)})</span>`
                : ''
            }</dd>
            <dt>Κατάσταση</dt><dd><span class="pill status-${escapeHtml(c.status)}">${escapeHtml(statusLabel(c.status))}</span></dd>
            <dt>Δημιουργία</dt><dd>${escapeHtml(c.created_at || '—')}</dd>
            <dt>Ενεργοποίηση</dt><dd>${escapeHtml(c.activated_at || '—')}</dd>
          </dl>
        </div>
        <div>
          <h3>Επικοινωνία</h3>
          <dl class="detail-dl">
            <dt>Όνομα</dt><dd>${escapeHtml(c.contact_name || '—')}</dd>
            <dt>Email</dt><dd>${escapeHtml(c.contact_email || '—')}</dd>
            <dt>Τηλέφωνο</dt><dd>${escapeHtml(c.contact_phone || '—')}</dd>
          </dl>
          ${
            c.status === 'failed' && c.provision_error
              ? `<p class="status-line error">${escapeHtml(c.provision_error)}</p>`
              : ''
          }
        </div>
      </div>

      <div class="detail-actions">
        <a class="btn btn-primary" href="${escapeHtml(url)}" target="_blank" rel="noopener">Άνοιγμα admin</a>
        ${retryBtn}
        ${archiveBtn}
      </div>

      ${editPlanSection}

      <h3>Provisioning log</h3>
      ${logsHtml}
    `;

    if (c.status === 'active' && allowPlanChange) {
      fillPlanSelect($('edit-plan-select'), c.plan);
      renderPlanPreview(c.plan, 'edit-plan-preview');
      $('edit-plan-select')?.addEventListener('change', syncEditPlanForm);
      $('edit-plan-form')?.addEventListener('submit', onEditPlanSubmit);
    }
  } catch (err) {
    $('detail-panel').innerHTML = `<p class="status-line error">${escapeHtml(err.message)}</p>`;
  }
}

async function onEditPlanSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const id = form.dataset.id;
  const subdomain = form.dataset.subdomain;
  const plan = $('edit-plan-select').value;
  const annual_price_eur = $('edit-price-input').value;
  const discount_note = $('edit-discount-note').value;
  const msg = $('edit-plan-msg');
  msg.classList.add('hidden');

  const confirmed = await openConfirmModal({
    title: 'Επεξεργασία πακέτου',
    body: `Θα ενημερωθεί το <code>prod.env</code> και θα επανεκκινηθεί το container του <strong>${escapeHtml(subdomain)}</strong> (ίδιο image, ίδιο port).<br>Πληκτρολόγησε <code>${escapeHtml(subdomain)}</code> για επιβεβαίωση.`,
    subdomain,
    requireExport: false,
  });
  if (!confirmed) return;

  const submitBtn = $('edit-plan-submit');
  if (submitBtn) submitBtn.disabled = true;
  try {
    const { data } = await api(`/api/clients/${id}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan,
        annual_price_eur,
        discount_note,
        confirm_subdomain: confirmed.confirm_subdomain,
      }),
    });
    msg.textContent = `Το πακέτο άλλαξε: ${data.oldPlan} → ${data.newPlan}.`;
    msg.className = 'status-line ok';
    msg.classList.remove('hidden');
    await loadClients();
    await openClientDetail(id);
  } catch (err) {
    const text = err.message || 'Αποτυχία αλλαγής πακέτου.';
    msg.textContent = text;
    msg.className = 'status-line error';
    msg.classList.remove('hidden');
    if (submitBtn) submitBtn.disabled = false;
  }
}

let modalResolve = null;

function closeModal() {
  $('action-modal').classList.add('hidden');
  $('modal-error').classList.add('hidden');
  $('modal-confirm-input').value = '';
  $('modal-export-ack').checked = false;
  if (modalResolve) {
    const resolve = modalResolve;
    modalResolve = null;
    resolve(null);
  }
}

function openConfirmModal({ title, body, subdomain, requireExport }) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    $('modal-title').textContent = title;
    $('modal-body').innerHTML = body;
    $('modal-export-row').classList.toggle('hidden', !requireExport);
    $('modal-error').classList.add('hidden');
    $('modal-confirm-input').value = '';
    $('modal-export-ack').checked = false;
    $('action-modal').classList.remove('hidden');
    $('modal-confirm-input').focus();
    $('modal-ok-btn').dataset.expected = subdomain;
  });
}

$('modal-cancel-btn')?.addEventListener('click', closeModal);
$('action-modal')?.addEventListener('click', (e) => {
  if (e.target === $('action-modal')) closeModal();
});
$('modal-ok-btn')?.addEventListener('click', () => {
  const expected = $('modal-ok-btn').dataset.expected || '';
  const typed = $('modal-confirm-input').value.trim().toLowerCase();
  const needExport = !$('modal-export-row').classList.contains('hidden');
  if (typed !== expected) {
    $('modal-error').textContent = 'Το subdomain δεν ταιριάζει.';
    $('modal-error').classList.remove('hidden');
    return;
  }
  if (needExport && !$('modal-export-ack').checked) {
    $('modal-error').textContent = 'Επιβεβαίωσε ότι έγινε export πρώτα.';
    $('modal-error').classList.remove('hidden');
    return;
  }
  const resolve = modalResolve;
  modalResolve = null;
  $('action-modal').classList.add('hidden');
  resolve({
    confirm_subdomain: typed,
    export_ack: needExport ? true : undefined,
  });
});

$('detail-panel')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  const subdomain = btn.dataset.subdomain;
  const action = btn.dataset.action;

  if (action === 'retry') {
    const confirmed = await openConfirmModal({
      title: 'Δοκίμασε ξανά',
      body: `Θα συνεχίσει από το βήμα <strong>${escapeHtml(btn.dataset.resume || '?')}</strong> χωρίς να ξαναγράψει επιτυχημένα βήματα / secrets.<br>Πληκτρολόγησε <code>${escapeHtml(subdomain)}</code> για επιβεβαίωση.`,
      subdomain,
      requireExport: false,
    });
    if (!confirmed) return;
    try {
      const { data } = await api(`/api/clients/${id}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(confirmed),
      });
      showView('new');
      $('new-client-form').classList.add('hidden');
      $('success-panel').classList.add('hidden');
      $('provision-panel').classList.remove('hidden');
      resetProvisionPanel();
      const start = data.resumeStep || 'dirs';
      for (const step of PROVISION_STEPS) {
        if (PROVISION_STEPS.indexOf(step) < PROVISION_STEPS.indexOf(start)) {
          setStepState(step, 'ok', 'skipped (already ok)');
        }
      }
      setStepState(start, 'running', '');
      pollProvision(id);
    } catch (err) {
      alert(err.message || 'Αποτυχία retry.');
    }
    return;
  }

  if (action === 'archive') {
    const confirmed = await openConfirmModal({
      title: 'Αρχειοθέτηση πελάτη',
      body: `Έγινε export πρώτα; Τρέξε χειροκίνητα <code>kollekta-export ${escapeHtml(subdomain)}</code> αν ο πελάτης ζητήσει τα δεδομένα του (GDPR).<br><br>Θα γίνει <strong>docker stop</strong> (όχι rm), αφαίρεση nginx vhost, και status → archived. Τα data στο disk μένουν. Port/subdomain δεν ελευθερώνονται.<br>Πληκτρολόγησε <code>${escapeHtml(subdomain)}</code>.`,
      subdomain,
      requireExport: true,
    });
    if (!confirmed) return;
    try {
      await api(`/api/clients/${id}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(confirmed),
      });
      await openClientDetail(id);
      await loadClients();
    } catch (err) {
      alert(err.message || 'Αποτυχία αρχειοθέτησης.');
    }
  }
});

document.getElementById('logout-btn')?.addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST', credentials: 'include' });
  location.href = '/login.html';
});

$('new-client-btn')?.addEventListener('click', openNewClient);
$('back-to-list-btn')?.addEventListener('click', () => {
  clearInterval(pollTimer);
  showView('list');
  loadClients().catch(() => {});
});
$('detail-back-btn')?.addEventListener('click', () => {
  showView('list');
  loadClients().catch(() => {});
});
$('nav-clients')?.addEventListener('click', (e) => {
  e.preventDefault();
  clearInterval(pollTimer);
  showView('list');
  loadClients().catch(() => {});
});
$('provision-done-btn')?.addEventListener('click', () => {
  clearInterval(pollTimer);
  showView('list');
  loadClients().catch(() => {});
});
$('success-done-btn')?.addEventListener('click', () => {
  showView('list');
  loadClients().catch(() => {});
});

$('copy-password-btn')?.addEventListener('click', async () => {
  if (!revealedPassword) return;
  try {
    await navigator.clipboard.writeText(revealedPassword);
    $('copy-password-btn').textContent = 'Αντιγράφηκε';
    setTimeout(() => {
      $('copy-password-btn').textContent = 'Αντιγραφή';
    }, 1500);
  } catch {
    $('copy-password-btn').textContent = 'Αποτυχία';
  }
});

$('clients-body')?.addEventListener('click', (e) => {
  const row = e.target.closest('tr.client-row');
  if (!row) return;
  openClientDetail(row.dataset.id);
});
$('clients-body')?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('tr.client-row');
  if (!row) return;
  e.preventDefault();
  openClientDetail(row.dataset.id);
});

$('plan-select')?.addEventListener('change', syncPriceFromPlan);
$('discount-note')?.addEventListener('input', updateDiscountPreview);

$('subdomain-input')?.addEventListener('input', (e) => {
  const raw = e.target.value;
  const lowered = raw.toLowerCase();
  if (raw !== lowered) e.target.value = lowered;
  clearTimeout(subdomainTimer);
  subdomainTimer = setTimeout(() => checkSubdomain(e.target.value.trim()), 280);
});

$('new-client-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('form-error');
  err.classList.add('hidden');

  const subdomain = $('subdomain-input').value.trim();
  const confirmSub = $('confirm-subdomain-input').value.trim().toLowerCase();
  if (!SUBDOMAIN_RE.test(subdomain) || !subdomainOk) {
    err.textContent = 'Διόρθωσε το subdomain πριν συνεχίσεις.';
    err.classList.remove('hidden');
    return;
  }
  if (confirmSub !== subdomain) {
    err.textContent = 'Η επιβεβαίωση subdomain δεν ταιριάζει.';
    err.classList.remove('hidden');
    return;
  }

  const form = e.target;
  const fd = new FormData(form);
  fd.set('confirm_subdomain', confirmSub);
  $('submit-client-btn').disabled = true;

  try {
    const { data } = await api('/api/clients', { method: 'POST', body: fd });
    form.classList.add('hidden');
    $('success-panel').classList.add('hidden');
    $('provision-panel').classList.remove('hidden');
    resetProvisionPanel();
    setStepState('dirs', 'running', '');
    pollProvision(data.client.id);
  } catch (ex) {
    err.textContent = ex.message || 'Αποτυχία.';
    err.classList.remove('hidden');
    $('submit-client-btn').disabled = false;
  }
});

(async function init() {
  try {
    const { data } = await api('/api/plans');
    plansOrder = data.plans || [];
    for (const plan of plansOrder) {
      plansById[plan.id] = plan;
    }
    fillPlanSelect($('plan-select'), 'basic');
    syncPriceFromPlan();
    await loadClients();
  } catch (err) {
    console.error(err);
  }
})();
