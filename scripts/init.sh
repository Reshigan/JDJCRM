#!/bin/sh
# First-time setup: generate secrets, build, start, create the administrator.
set -e
cd "$(dirname "$0")/.."
mkdir -p secrets && chmod 700 secrets
[ -f secrets/db_password ] || head -c 32 /dev/urandom | base64 | tr -d '/+=\n' > secrets/db_password
[ -f secrets/master_key ] || head -c 32 /dev/urandom | base64 | tr -d '\n' > secrets/master_key
# The directory keeps other host users out; the files must be readable inside the containers (api runs as uid 1000, db as postgres).
chmod 644 secrets/*
[ -f .env ] || cp .env.example .env
docker compose build
docker compose up -d
echo "Creating administrator (set ADMIN_EMAIL / ADMIN_PASSWORD in .env to choose)…"
docker compose exec -T -e ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(grep ^ADMIN_PASSWORD= .env | cut -d= -f2-)}" api node dist/seed.js
echo
echo "Pelo CRM is up. BACK UP secrets/master_key NOW — without it, attachments cannot be decrypted."
