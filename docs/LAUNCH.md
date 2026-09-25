# Launch readiness

## What CI proves on every push

| Area | How it is tested |
|---|---|
| Install | `scripts/init.sh` builds and starts the real stack, generates secrets and creates the administrator. |
| First sign-in | Browser: the administrator must enrol two-factor, sees System status green (worker, audit chain, migrations), then creates a Client Services user, who must also enrol. |
| Sign-in rules | Enforced two-factor; 5 wrong passwords or codes lock the account; sign-out; a password change ends other sessions; expired sessions; deactivated users. |
| Active Directory | Group mapping sets role and department. No group means no access. An AD login cannot take over a local account. Locked AD accounts are refused. (Tested against a simulated directory.) |
| Route guard | Every one of the ~58 API routes refuses anonymous and two-factor-pending callers. The public list is pinned (health, sign-in, signed LIS webhook). |
| Roles and data scope | Departments see only their tickets. Pre-Analytical sees only the bleed it holds. Admin and management can never hold department scope. Percent-encoded path bypasses are blocked. |
| Query journey | Log → route → two departments respond → review → verification call → closure gate → close → effectiveness check (browser, plus API with DB triggers). |
| Bleed journey | Dispatch → geofenced arrival → capture **with the network off** → sync → lab stages → report filed → close. Also covered: geofence override, mock location, implausible locations, late-sync flag, cancellation. |
| Escalation and SLA | Working-hours clocks (SAST, holidays), 80/100/150% escalation, breach reasons, pending reasons from the LIS. |
| Dashboard | Live view and breach register, analytics, Excel export, wall mode, scheduled e-mail reports, the Quality tab, live push within 5 s. |
| Client register | Intake lookup, duplicate detection, supervisor-only audited merge. |
| E-mail | Real SMTP delivery over STARTTLS to a relay with a private-CA certificate. Messages carry a title and link only, never patient details. |
| SkyLIMS | HL7 v2 over a real MLLP socket: received → accepted → released, split frames, replays, partial results, unknown requisitions, malformed input, address allow-list. The real container answers `MSA\|AA`. |
| POPIA | Read audit, subject access export, retention purge, minimisation in logs, e-mail and LIS storage. |
| Audit trail | Hash chain verified after every test suite, after restore, and after key rotation. |
| Backup and restore | `backup.sh` → `restore.sh` run for real. The audit chain is verified and the application comes back. |
| Key rotation | `rotate-key.sh` run for real. Photos still decrypt with the new key, the old key is retired, and the rotation is audited. |
| Security headers | CSP and HSTS through Caddy over HTTPS. |
| Accessibility | WCAG 2.1 AA scan of every main screen (desktop and phone, light and dark). It fails on any serious or critical issue. |
| Performance | 100,000 queries and 20,000 bleeds: every board, search, dashboard and export is timed against a budget. |
| Android | APK builds with the native mock-location check (`android.yml`, run on demand). |

Totals: 73 API/DB tests and 16 browser tests. The browser tests run against the dev servers **and** the Docker stack.

## On-site checks before go-live (need JDJ's systems)

Tick each one in the production environment.

- [ ] **DNS and certificate.** `https://crm.jdj.local` opens without a warning on a CS PC and a nurse's phone (Caddy CA installed, or JDJ certificate mounted).
- [ ] **Active Directory.**
  - Put the domain controller's CA in `./certs` and set `LDAP_CA_FILE`.
  - Map the AD groups in Administration.
  - Sign in with one account per role.
  - Check that someone outside the groups is refused.
- [ ] **E-mail relay.** If the relay uses an internal CA, set `SMTP_CA_FILE`. Log a test query and confirm the department receives the e-mail.
- [ ] **Two-factor.** Each CS, management and admin user enrols on their phone at first sign-in.
- [ ] **Hospitals.** Check GPS positions and geofence radii. A nurse stands at each hospital entrance and gets "You are at …".
- [ ] **Field phones.**
  - Install the APK or PWA and sign in.
  - Capture one test bleed in a dead zone and confirm it syncs.
  - Confirm that a fake-GPS app is refused.
- [ ] **SkyLIMS.** Confirm the message mapping with Mukon ([LIS.md](LIS.md)). Then:
  - set `COMPOSE_PROFILES=skylims` and `SKYLIMS_ALLOW`;
  - run `node scripts/hl7-ping.mjs` from the SkyLIMS server;
  - follow one real requisition through received, accepted and released.
- [ ] **Configuration.** Time limits per category (brief: TBC), bleed limits, holidays, sites and hours, report distribution lists, retention.
- [ ] **Backups.**
  - The first nightly backup appears in System status.
  - Off-site copy is configured.
  - `secrets/master_key` is stored in the password vault.
  - One restore drill has been done on a spare host.
- [ ] **Remove demo data.** Production is installed with `init.sh` only (no `--demo`). Demo users must not exist.
- [ ] **Sign-off.** One CS agent, one department responder, one nurse and one manager each complete their journey with a real (test) patient.
