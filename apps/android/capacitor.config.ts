import type { CapacitorConfig } from '@capacitor/cli';

// A thin native shell around the on-prem field PWA. Set BATON_URL when syncing: BATON_URL=https://crm.jdj.local npm run sync
const url = process.env.BATON_URL ?? 'https://crm.local';

const config: CapacitorConfig = {
  appId: 'za.co.jdj.baton',
  appName: 'Pelo CRM Field',
  webDir: 'www',
  server: { url: `${url}/field`, cleartext: false, allowNavigation: [new URL(url).host] },
  android: { allowMixedContent: false },
};
export default config;
