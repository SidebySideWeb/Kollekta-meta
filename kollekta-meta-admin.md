# Kollekta Meta-admin

Ξεχωριστή διεργασία που δημιουργεί customer instances του Kollekta στο ίδιο host.
Κρατήστε αυτό το έγγραφο συγχρονισμένο με τον κώδικα (`lib/provision.js`) — αν αλλάξει το ένα, αλλάζει και το άλλο.

---

## Μέρος Α — Χειροκίνητο / αυτοματοποιημένο provisioning

Η ροή `provision(clientId)` στο `lib/provision.js` αυτοματοποιεί ακριβώς τα παρακάτω βήματα, με τη σειρά. Σε αποτυχία **δεν** γίνεται auto-rollback· μένει το μερικό state για χειροκίνητο έλεγχο.

### 0. Port

- `SELECT MAX(port) FROM clients WHERE port IS NOT NULL` — αν κενό, ξεκινά από **3100**, αλλιώς `max + 1`.
- Πριν τη δέσμευση, έλεγχος και με `docker ps -a` port bindings (σε περίπτωση που container αφαιρέθηκε χωρίς ενημέρωση του πίνακα).
- Το port γράφεται αμέσως στο row του client, πριν από οποιοδήποτε άλλο βήμα.

### 1. dirs

```bash
mkdir -p /srv/kollekta/instances/{subdomain}/{data,uploads,logo}
chown -R 1000:1000 /srv/kollekta/instances/{subdomain}
```

Το uid/gid `1000:1000` ταιριάζει με τον non-root χρήστη του container (Φάση 1, Βήμα 6).

`INSTANCE_DATA_ROOT` (default `/srv/kollekta/instances`) μπορεί να υπερισχύσει μέσω env.

### 2. env

Γράφεται το αρχείο:

`/srv/kollekta/instances/{subdomain}/prod.env`

με (τουλάχιστον):

| Μεταβλητή | Πηγή |
|-----------|------|
| `PLAN`, `QUOTA_GB`, `QUOTA_WARN_PERCENT` | κοινό `lib/plans.js` (ίδιο με το preview της φόρμας M3) |
| `ADMIN_PASSWORD` | `crypto.randomBytes(12).toString('hex')` — **όχι** base64 (`/` και `+` σπάνε το Docker `--env-file`) |
| `SESSION_COOKIE_SECRET` | `crypto.randomBytes(32).toString('hex')` |
| `EMAIL_PROVIDER` | `smtp` |
| `EMAIL_FROM` | `{subdomain}@kollekta.gr` |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` | από το config του meta-admin (κοινός λογαριασμός αποστολής) |

`chmod 600` στο αρχείο.

Το `ADMIN_PASSWORD` μένει **μόνο στη μνήμη** μέχρι να εμφανιστεί μία φορά στο M5 — δεν γράφεται στον πίνακα `clients` ούτε στο `provisioning_log`.

### 3. nginx

- Render vhost από `templates/nginx-vhost.conf.tpl`:
  - `server_name {subdomain}.kollekta.gr`
  - `proxy_pass http://127.0.0.1:{port}`
  - wildcard cert paths (`SSL_FULLCHAIN` / `SSL_PRIVKEY`, default Let’s Encrypt `kollekta.gr`)
  - `include` του security-headers snippet (Φάση 2, Βήμα 11) — default  
    `/etc/nginx/snippets/kollekta-security-headers.conf`  
    (αντίγραφο αναφοράς: `templates/kollekta-security-headers.conf`)
- Αρχείο: `/etc/nginx/sites-available/{subdomain}.conf`
- Symlink σε `sites-enabled`
- `nginx -t` — αν αποτύχει, **διαγραφή** του conf και fail του βήματος· **ποτέ** reload με άκυρο config
- Σε επιτυχία: `systemctl reload nginx`

### 4. container

```bash
docker run -d --name kollekta_{subdomain} --restart unless-stopped \
  -p 127.0.0.1:{port}:3000 \
  --env-file /srv/kollekta/instances/{subdomain}/prod.env \
  -v .../data:/app/data \
  -v .../uploads:/app/uploads \
  -v .../logo:/app/public/logo \
  kollekta:latest
```

Μετά το start, έλεγχος ότι το port binding string περιέχει `127.0.0.1:` — αν δημοσιευτεί σε `0.0.0.0`, το βήμα αποτυγχάνει δυνατά.

### 5. healthcheck

- Poll κάθε **2s**, συνολικά έως **15s**, στο `http://127.0.0.1:{port}/` (και fallback `/api/branding`).
- Επιτυχία → `status = active`, `activated_at = now`.
- Timeout → `status = failed` με το τελευταίο error· το container **μένει** να τρέχει για debugging.

### Progress UI

Το frontend κάνει poll στο `GET /api/clients/:id/status` (όχι websockets).

---

## Φάση 4 — Μετά το provisioning (χειροκίνητο checklist)

Δεν ανήκει στο meta-admin UI ως interactive state — εμφανίζεται μόνο ως υπενθύμιση
μετά την επιτυχία (M5). Πηγή στον κώδικα: `lib/postProvisionChecklist.js`.

1. Στείλε το URL admin και τον κωδικό στον υπεύθυνο επικοινωνίας (εκτός αυτού του tool).
2. Άνοιξε `https://{subdomain}.kollekta.gr/admin` και επιβεβαίωσε σύνδεση με τον νέο κωδικό.
3. Αν δεν ανέβηκε λογότυπο στη φόρμα, ανέβασέ το από το admin του instance.
4. Στείλε δοκιμαστικό email από το instance (νέος πελάτης / επαναφορά κωδικού) για να επιβεβαιώσεις SMTP.
5. Καταχώρισε την ετήσια τιμή / έκπτωση στο τιμολογιακό σου σύστημα.
6. Πρόσθεσε το subdomain στη λίστα παρακολούθησης (backup, disk, uptime).

---

## Μέρος Β — Retry, αρχειοθέτηση, audit

### Επιβεβαίωση subdomain

Πριν από `provision()` (νέος πελάτης ή retry) και πριν από αρχειοθέτηση, απαιτείται
πληκτρολόγηση του subdomain ξανά (`confirm_subdomain`).

### Retry (`POST /api/clients/:id/retry`)

Για `status=failed`: συνεχίζει από το πρώτο βήμα που δεν έχει `ok` στο
`provisioning_log`. Δεν ξαναγράφει επιτυχημένα βήματα· αν υπάρχει ήδη `prod.env`,
δεν αναγεννά secrets.

### Αρχειοθέτηση (`POST /api/clients/:id/archive`)

1. Υπενθύμιση export: `kollekta-export <subdomain>` (GDPR).
2. `docker stop` (όχι `rm`).
3. Αφαίρεση nginx vhost → `nginx -t` → `systemctl reload nginx`.
4. Τα `/srv/kollekta/instances/{subdomain}/` μένουν στο disk.
5. Port και subdomain **δεν** ελευθερώνονται.

### Audit log

Πίνακας `audit_log`: actor (default `owner`), action, client_id, subdomain, detail, ip, at.
Γράφεται για login, logout, create, provision start/retry/success/failed, archive,
plan.change / plan.change.failed / plan.change.health_failed.

---

## Πακέτα (`lib/plans.js`)

| Plan | GB | Retention | Ετήσιο € | Features |
|------|----|-----------|----------|----------|
| basic | 10 | 12 μήνες | 300 | χωρίς κωδικούς / ετικέτες |
| pro | 25 | 24 μήνες | 600 | pro+ |
| business | 60 | άπειρο | 1100 | pro+ |
| demo | 1 | 1 μήνας | 0 (εξαιρείται από revenue) | όπως basic |

Το **demo** είναι εσωτερικό (trial για prospect) — όχι για τη δημόσια τιμολόγηση kollekta.gr.
Στη λίστα / λεπτομέρεια εμφανίζεται badge `DEMO`.

### Αλλαγή πακέτου (`POST /api/clients/:id/plan`)

Μόνο για `status=active`. Ενημερώνει γραμμές στο `prod.env` (PLAN, QUOTA_GB,
FEATURE_*, DEFAULT_RETENTION_MONTHS — όχι secrets/SMTP/STORAGE overrides),
επαναδημιουργεί το container στο **ίδιο** image/port, healthcheck, μετά DB + audit.
Επιβεβαίωση με πληκτρολόγηση subdomain.


