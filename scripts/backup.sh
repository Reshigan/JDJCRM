#!/bin/sh
# On-demand backup (the `backup` service also runs nightly). Writes to ./backups on the host.
set -e
cd "$(dirname "$0")/.."
ts=$(date +%F_%H%M)
mkdir -p backups
docker compose exec -T db sh -c 'pg_dump -U baton -Fc baton' > "backups/baton_$ts.dump"
docker compose run --rm -T -v "$PWD/backups:/out" --entrypoint sh api -c "tar czf /out/blobs_$ts.tgz -C /data ."
echo "backups/baton_$ts.dump + backups/blobs_$ts.tgz written. The master key is NOT included — keep secrets/master_key safe separately."
