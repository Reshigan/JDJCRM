import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from './db';

const dir = process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL('../migrations', import.meta.url));

export async function migrate() {
  await sql`create table if not exists schema_migrations (name text primary key, at timestamptz default now())`;
  const done = new Set((await sql`select name from schema_migrations`).map((r) => r.name));
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    await sql.begin(async (tx) => {
      await tx.unsafe(readFileSync(`${dir}/${f}`, 'utf8'));
      await tx`insert into schema_migrations (name) values (${f})`;
    });
    console.log(`migrated ${f}`);
  }
}

if (/[\/]migrate\.[jt]s$/.test(process.argv[1] ?? '')) { // run as a script, not when bundled into server
  await migrate();
  await sql.end();
}
