// Active Directory sign-in: bind as the user over LDAPS, then resolve nested group membership.
import { readFileSync } from 'node:fs';
import { Client } from 'ldapts';
import { env } from './env';

export const ldapEnabled = () => !!(env.ldap.url && env.ldap.baseDn);

export async function adAuthenticate(login: string, password: string) {
  if (!ldapEnabled() || !password) return null;
  const upn = login.includes('@') || !env.ldap.upnSuffix ? login : `${login}@${env.ldap.upnSuffix}`;
  const client = new Client({
    url: env.ldap.url!,
    timeout: 5000,
    connectTimeout: 5000,
    tlsOptions: env.ldap.caFile ? { ca: [readFileSync(env.ldap.caFile)] } : undefined,
  });
  try {
    await client.bind(upn, password);
    const esc = (s: string) => s.replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
    const { searchEntries } = await client.search(env.ldap.baseDn!, {
      filter: `(userPrincipalName=${esc(upn)})`,
      attributes: ['distinguishedName', 'displayName', 'mail'],
    });
    const me = searchEntries[0];
    if (!me) return null;
    const groups = await client.search(env.ldap.baseDn!, {
      filter: `(member:1.2.840.113556.1.4.1941:=${esc(String(me.dn))})`, // LDAP_MATCHING_RULE_IN_CHAIN
      attributes: ['dn'],
    });
    return {
      email: String(me.mail || upn).toLowerCase(),
      name: String(me.displayName || upn),
      groups: groups.searchEntries.map((g) => g.dn.toLowerCase()),
    };
  } catch {
    return null;
  } finally {
    await client.unbind().catch(() => {});
  }
}
