import { readFileSync } from 'node:fs';

const fileOr = (name: string) => {
  const f = process.env[`${name}_FILE`];
  return f ? readFileSync(f, 'utf8').trim() : process.env[name];
};

export const env = {
  databaseUrl: fileOr('DATABASE_URL') ?? 'postgres://baton@127.0.0.1:5433/baton',
  masterKey: fileOr('MASTER_KEY'), // base64, 32 bytes; required for attachments
  dataDir: process.env.DATA_DIR ?? './data',
  appUrl: process.env.APP_URL ?? 'http://localhost:5173',
  port: Number(process.env.PORT ?? 3000),
  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 25),
    user: process.env.SMTP_USER,
    pass: fileOr('SMTP_PASS'),
    from: process.env.SMTP_FROM ?? 'Baton <baton@localhost>',
  },
  ldap: {
    url: process.env.LDAP_URL, // ldaps://dc01.jdj.local
    baseDn: process.env.LDAP_BASE_DN, // DC=jdj,DC=local
    upnSuffix: process.env.LDAP_UPN_SUFFIX, // jdj.local — appended when a bare username is typed
    caFile: process.env.LDAP_CA_FILE,
  },
};
