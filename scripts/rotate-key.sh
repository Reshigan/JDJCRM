#!/bin/sh
# Rotate the attachment/photo master key. Take a backup first.
set -e
cd "$(dirname "$0")/.."
head -c 32 /dev/urandom | base64 | tr -d '\n' > secrets/master_key.new && chmod 600 secrets/master_key.new
docker compose stop worker
docker compose run --rm -T -v "$PWD/secrets/master_key.new:/run/secrets/new_master_key:ro" -e NEW_MASTER_KEY_FILE=/run/secrets/new_master_key api node dist/rotate-key.js
cp secrets/master_key "secrets/master_key.retired.$(date +%F)" && mv secrets/master_key.new secrets/master_key
docker compose up -d --force-recreate api worker
echo "Rotated. Keep the retired key until every backup taken before today has expired."
