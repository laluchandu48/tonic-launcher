/**
 * Tonic credentials live server-side only. The browser never receives them —
 * the settings API reports whether they are configured and shows a masked key,
 * nothing more.
 *
 * Precedence: the .env file wins over anything saved through the UI, so a
 * deployed instance can be configured entirely by environment.
 *
 * For AWS this should move to Secrets Manager or SSM Parameter Store; the only
 * thing that changes is the body of readCredentials().
 */
import { settings } from '../db/index.js';
import { TonicV4Client } from './tonicV4.js';

const KEY_SETTING = 'tonic.consumer_key';
const SECRET_SETTING = 'tonic.consumer_secret';

let cachedV4Client = null;
// The client is rebuilt whenever the stored credentials change.
let cachedV4Fingerprint = null;

export function readCredentials() {
  const consumerKey = process.env.TONIC_CONSUMER_KEY || settings.get(KEY_SETTING);
  const consumerSecret = process.env.TONIC_CONSUMER_SECRET || settings.get(SECRET_SETTING);
  return {
    consumerKey: consumerKey || null,
    consumerSecret: consumerSecret || null,
    fromEnv: Boolean(process.env.TONIC_CONSUMER_KEY && process.env.TONIC_CONSUMER_SECRET),
  };
}

export function saveCredentials({ consumerKey, consumerSecret }) {
  settings.set(KEY_SETTING, consumerKey);
  settings.set(SECRET_SETTING, consumerSecret);
  cachedV4Client = null;
  cachedV4Fingerprint = null;
}

export function clearCredentials() {
  settings.delete(KEY_SETTING);
  settings.delete(SECRET_SETTING);
  cachedV4Client = null;
  cachedV4Fingerprint = null;
}

export function isConfigured() {
  const { consumerKey, consumerSecret } = readCredentials();
  return Boolean(consumerKey && consumerSecret);
}

/** Show enough of the key to recognise it, never enough to use it. */
export function maskedKey() {
  const { consumerKey } = readCredentials();
  if (!consumerKey) return null;
  if (consumerKey.length <= 6) return '••••';
  return `${consumerKey.slice(0, 3)}${'•'.repeat(Math.max(4, consumerKey.length - 6))}${consumerKey.slice(-3)}`;
}


/**
 * The v4 client, for features that only exist there (compliance today).
 * Same stored credentials — v4 just spells them camelCase on the wire.
 */
export function getV4Client() {
  const { consumerKey, consumerSecret } = readCredentials();
  const fingerprint = `${consumerKey}:${consumerSecret}`;
  if (!cachedV4Client || cachedV4Fingerprint !== fingerprint) {
    cachedV4Client = new TonicV4Client({ consumerKey, consumerSecret });
    cachedV4Fingerprint = fingerprint;
  }
  return cachedV4Client;
}
