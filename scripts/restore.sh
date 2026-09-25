#!/bin/sh
# Restore a backup into this installation, replacing current data.
# Usage: ./scripts/restore.sh backups/baton_<ts>.dump backups/blobs_<ts>.tgz
# secrets/master_key must be the key that was in use when the backup was taken.
set -e
cd "$(dirname "$0")/.."
[ -f "$1" ] && [ -f "$2" ] || { echo "usage: $0 <baton.dump> <blobs.tgz>"; exit 1; }
printf "This REPLACES all current Pelo CRM data. Type RESTORE to continue: "; read ok; [ "$ok" = RESTORE ] || exit 1
docker compose --profile skylims stop api worker web lis
docker compose exec -T db sh -c 'dropdb -U baton --if-exists baton && createdb -U baton baton'
docker compose exec -T db sh -c 'pg_restore -U baton -d baton --no-owner' < "$1"
docker compose run --rm -T -v "$PWD/$(dirname "$2"):/in" --entrypoint sh api -c "rm -rf /data/blobs && tar xzf /in/$(basename "$2") -C /data"
docker compose up -d
echo "Verifying the audit hash chain…"
docker compose exec -T db psql -U baton -d baton -tAc "select coalesce('BROKEN at #' || audit_verify(), 'audit chain intact')"
