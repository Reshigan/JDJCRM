# Baton operations runbook

Everything here runs on the Docker host, from the repository directory. Times are SAST.

## First install

1. Set up DNS (`baton.jdj.local`) and open ports 80/443 to the server.
2. Copy the environment file and fill it in:

   ```sh
   cp .env.example .env
   ```

   | Setting | What to set |
   |---|---|
   | `SITE_ADDRESS`, `APP_URL` | the server's DNS name |
   | `ADMIN_PASSWORD` | the first administrator's password |
   | `SMTP_*` | your mail relay |
   | `LDAP_*` | optional, for AD sign-in |

3. Run `./scripts/init.sh`. It generates `secrets/`, builds, starts, runs the migrations and creates the administrator.
4. **Store `secrets/master_key` in the password vault now.** Backups do not contain it, and attachments and bleed photos cannot be decrypted without it.
5. Sign in as the administrator. You must set up two-factor sign-in first. Then configure:
   - sites and working hours
   - public holidays (2026–27 are seeded)
   - departments, categories, routing and time limits
   - hospitals (GPS position, geofence radius, allocated nurse)
   - AD groups
   - users
   - Settings: `bleed_limits`, `report_*`, `retention_days`
6. Give the root certificate of Caddy's internal CA to phones and PCs, or mount your own certificate (see the README).

## Daily checks

| Check | How |
|---|---|
| System status | **Administration → System status**: every row green |
| Services healthy | `docker compose ps` shows every container `healthy` / `running` |
| Last night's backup exists | `docker compose logs --since 26h backup` shows `backup <date> ok` |
| Audit trail intact | Administration → Audit trail shows "Hash chain verified" |
| E-mail reports went out | Audit trail shows `report.daily` entries |

## Backups

- **Automatic.** The `backup` container writes a database dump and an attachment archive nightly to the `backups` volume, and keeps 14 days.
- **On demand.** `./scripts/backup.sh` writes to `./backups/` on the host.
- **Off-site.** Copy `backups/` (or the `baton_backups` volume) to off-site storage, following your records policy.
- **The key.** The master key is not in the backup. Keep it in the vault, and keep every retired key until the last backup made with it has expired.

## Restore (and the quarterly restore drill)

```sh
./scripts/restore.sh backups/baton_<ts>.dump backups/blobs_<ts>.tgz
```

1. The script stops the app, replaces the database and attachment store, and restarts.
2. It then verifies the audit hash chain. The expected result is `audit chain intact`.
3. `secrets/master_key` must be the key that was current when the backup was taken.
4. **Drill.** Restore last night's backup onto a spare host once a quarter, sign in, and open a bleed with photos.

Verified during development: a dump restored into a fresh database had identical row counts and an intact chain.

## Rotating the master key

Rotate yearly, or at once if the key may have leaked.

```sh
./scripts/backup.sh && ./scripts/rotate-key.sh
```

- The rotation re-wraps every per-file key in one database transaction. The encrypted files are not rewritten, so it takes seconds.
- It is recorded in the audit trail as `security.master_key_rotated`.
- The old key is kept as `secrets/master_key.retired.<date>`, which you need to restore older backups.
- Verified during development: after rotation, every photo decrypted with the new key and none with the old one.

## Upgrades

```sh
git pull && docker compose build && docker compose up -d
```

Migrations run automatically when the API starts, and each runs in a transaction. Take a backup first.

## Air-gapped sites

1. On a connected machine, run `docker compose build`, then `docker save baton-api baton-web postgres:16-alpine caddy:2-alpine | gzip > baton.tgz`.
2. On the server, run `docker load < baton.tgz`, then `docker compose up -d`.

## Incidents

| Symptom | Action |
|---|---|
| Alert "Baton worker has stopped" | Escalations, reports and retention are paused. Run `docker compose ps worker` and `docker compose logs --tail 100 worker`, then `docker compose up -d worker`. The alert repeats at most hourly until the worker's heartbeat is back. |
| A user is locked out | Administration → Users → edit → **Unlock account**. It unlocks by itself after 15 minutes. |
| A user lost their phone (2FA) | Administration → Users → edit → **Reset two-factor**. Their sessions end, and they enrol again at their next sign-in. |
| "Chain broken at entry #N" on the audit page | Someone altered the database directly. Preserve the host, restore the last good backup elsewhere and compare entries around #N, then report under your POPIA breach procedure. |
| Nurses report "outside the geofence" at one hospital | Check the hospital's GPS position and radius in Administration → Practices & hospitals. Large campuses usually need 400–600 m. |
| Implausible-location alerts for a nurse | Review the bleed's geolocation evidence. Repeated alerts suggest a fake-GPS app. The Android app refuses to proceed while one is active. |
| E-mail not arriving | `docker compose logs api worker \| grep mail`. The relay must support STARTTLS; for a relay without it, set `SMTP_REQUIRE_TLS=false`. |

## POPIA

- **Access requests (s23).**
  1. A Client Services supervisor or a manager searches for the person in Baton.
  2. **POPIA access report** downloads every record held about them, and everyone who viewed those records.
  3. The export itself is audited.
- **Minimisation.**
  - Boards show a patient reference (initials and folder number), not the full name.
  - E-mails carry only a title and a link.
  - Request logs omit query strings.
- **Retention.** Set `retention_days` in Settings. Photos and attachments are purged that many days after their ticket closes. The purge runs hourly and is audited as `retention.purged`.
- **Read audit.** Opening a ticket or bleed, and viewing a photo or attachment, is logged per user, once per 15 minutes per record.
