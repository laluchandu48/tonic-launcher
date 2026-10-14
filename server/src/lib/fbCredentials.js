/**
 * Facebook credentials, stored the same way the Tonic ones are: server-side
 * only, with the environment taking precedence over anything saved in the UI.
 * The browser is told whether a token exists and shown a masked version of it,
 * never the token itself.
 *
 * The join parameter lives here too. It is the tracking-link parameter that
 * carries the Facebook adset ID into Tonic (subid1-4, network, site, siteid,
 * adtitle, or a custom one), and it is the single thing the whole Final Data
 * screen depends on — so it is configurable rather than assumed.
 */
import { settings } from '../db/index.js';
import { FacebookClient, normaliseAdAccountId } from './facebook.js';

const TOKEN_SETTING = 'fb.access_token';
const ACCOUNT_SETTING = 'fb.ad_account_id';
const VERSION_SETTING = 'fb.api_version';
const JOIN_SETTING = 'fb.join_param';
/* The accounts the dashboard adds up. Separate from ACCOUNT_SETTING, which is
   only the Final Data picker's last position — one is a choice about what the
   dashboard means, the other is where you happened to be looking. */
const DASHBOARD_ACCOUNTS_SETTING = 'fb.dashboard_accounts';

export const DEFAULT_JOIN_PARAM = 'subid2';
export const DEFAULT_API_VERSION = 'v24.0';

/** The parameters Tonic exposes by name; anything else is treated as custom. */
export const KNOWN_JOIN_PARAMS = [
  'subid1', 'subid2', 'subid3', 'subid4',
  'network', 'site', 'siteid', 'adtitle',
];

let cachedClient = null;
let cachedFingerprint = null;

export function readFbSettings() {
  const accessToken = process.env.FB_ACCESS_TOKEN || settings.get(TOKEN_SETTING);
  const adAccountId = process.env.FB_AD_ACCOUNT_ID || settings.get(ACCOUNT_SETTING);
  return {
    accessToken: accessToken || null,
    adAccountId: normaliseAdAccountId(adAccountId),
    apiVersion: process.env.FB_API_VERSION || settings.get(VERSION_SETTING) || DEFAULT_API_VERSION,
    joinParam: process.env.FB_JOIN_PARAM || settings.get(JOIN_SETTING) || DEFAULT_JOIN_PARAM,
    dashboardAccounts: readDashboardAccounts(),
    fromEnv: Boolean(process.env.FB_ACCESS_TOKEN),
  };
}

/**
 * The ad accounts the dashboard totals, as stored.
 *
 * An empty list means "none chosen yet" rather than "none" — the dashboard
 * treats it as nothing to show and says so, instead of silently reporting zero
 * spend, which would read as a quiet day rather than an unanswered question.
 */
export function readDashboardAccounts() {
  const raw = settings.get(DASHBOARD_ACCOUNTS_SETTING);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    // Normalise on the way out as well as in: a value stored by an older
    // version, or hand-edited, should not reach the Graph API unchecked.
    return [...new Set(list.map(normaliseAdAccountId).filter(Boolean))];
  } catch {
    return [];
  }
}

export function saveDashboardAccounts(ids) {
  const clean = [...new Set((Array.isArray(ids) ? ids : []).map(normaliseAdAccountId).filter(Boolean))];
  settings.set(DASHBOARD_ACCOUNTS_SETTING, JSON.stringify(clean));
  return clean;
}

export function saveFbSettings({ accessToken, adAccountId, apiVersion, joinParam }) {
  // An empty token on save means "keep the one already stored", so the screen
  // can show a masked value and still let the other fields be edited.
  if (accessToken) settings.set(TOKEN_SETTING, accessToken.trim());
  if (adAccountId !== undefined) settings.set(ACCOUNT_SETTING, normaliseAdAccountId(adAccountId) || '');
  if (apiVersion !== undefined) settings.set(VERSION_SETTING, String(apiVersion || '').trim() || DEFAULT_API_VERSION);
  if (joinParam !== undefined) settings.set(JOIN_SETTING, String(joinParam || '').trim() || DEFAULT_JOIN_PARAM);
  cachedClient = null;
  cachedFingerprint = null;
}

export function clearFbSettings() {
  for (const key of [TOKEN_SETTING, ACCOUNT_SETTING, VERSION_SETTING, JOIN_SETTING, DASHBOARD_ACCOUNTS_SETTING]) settings.delete(key);
  cachedClient = null;
  cachedFingerprint = null;
}

/**
  * The token is the credential. The ad account is chosen per view on the Final
  * Data screen and only remembered here, so it is not part of being configured.
  */
export function isFbConfigured() {
  return Boolean(readFbSettings().accessToken);
}

/** Remember the last ad account picked, so the screen opens where you left it. */
export function rememberAdAccount(adAccountId) {
  const id = normaliseAdAccountId(adAccountId);
  if (id) settings.set(ACCOUNT_SETTING, id);
  return id;
}

/** Enough of the token to recognise it, never enough to use it. */
export function maskedToken() {
  const { accessToken } = readFbSettings();
  if (!accessToken) return null;
  if (accessToken.length <= 10) return '••••';
  return `${accessToken.slice(0, 6)}${'•'.repeat(12)}${accessToken.slice(-4)}`;
}

export function getFbClient() {
  const { accessToken, adAccountId, apiVersion } = readFbSettings();
  const fingerprint = `${accessToken}:${adAccountId}:${apiVersion}`;
  if (!cachedClient || cachedFingerprint !== fingerprint) {
    cachedClient = new FacebookClient({ accessToken, adAccountId, apiVersion });
    cachedFingerprint = fingerprint;
  }
  return cachedClient;
}

/** Same shape as requireCredentials, for the Facebook side. */
export function requireFbCredentials(req, res, next) {
  if (!isFbConfigured()) {
    return res.status(428).json({
      error: 'Facebook API credentials are not configured.',
      hint: 'Add an access token on the FB Settings screen.',
      code: 'NO_FB_CREDENTIALS',
    });
  }
  next();
}
