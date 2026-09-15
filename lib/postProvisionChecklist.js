/**
 * Φάση 4 — χειροκίνητο checklist μετά το provisioning.
 * Plain-text only in the UI; this tool does not track checklist state.
 * Keep in sync with kollekta-meta-admin.md «Φάση 4».
 */
const POST_PROVISION_CHECKLIST = [
  'Στείλε το URL admin και τον κωδικό στον υπεύθυνο επικοινωνίας (εκτός αυτού του tool).',
  'Άνοιξε https://{subdomain}.kollekta.gr/admin και επιβεβαίωσε σύνδεση με τον νέο κωδικό.',
  'Αν δεν ανέβηκε λογότυπο στη φόρμα, ανέβασέ το από το admin του instance.',
  'Στείλε δοκιμαστικό email από το instance (νέος πελάτης / επαναφορά κωδικού) για να επιβεβαιώσεις SMTP.',
  'Καταχώρισε την ετήσια τιμή / έκπτωση στο τιμολογιακό σου σύστημα.',
  'Πρόσθεσε το subdomain στη λίστα παρακολούθησης (backup, disk, uptime).',
];

function checklistForSubdomain(subdomain) {
  const sub = String(subdomain || '').trim().toLowerCase() || '{subdomain}';
  return POST_PROVISION_CHECKLIST.map((line) => line.replaceAll('{subdomain}', sub));
}

module.exports = {
  POST_PROVISION_CHECKLIST,
  checklistForSubdomain,
};
