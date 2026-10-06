/**
 * Client for the Facebook (Meta) Marketing API — spend only.
 *
 * The launcher reads from Facebook; it never writes. Everything it needs comes
 * from one Insights call at adset level, so the access token only has to carry
 * ads_read. A token with more scope than that is a liability, not a feature.
 *
 * Graph API versions are supported for roughly two years from release, so the
 * version is configurable rather than pinned in code — when Meta retires the
 * one below, bumping it on the FB Settings screen is the whole fix.
 */

import { Agent } from 'undici';

const DEFAULT_VERSION = 'v24.0';
// Overridable so the merge logic can be exercised against a mock; in normal
// use this is never set.
const BASE = process.env.FB_GRAPH_BASE_URL || 'https://graph.facebook.com';

// Same reasoning as the Tonic client: a VPN that advertises IPv6 without
// routing it makes every request hang until the connect timeout, and the
// failure looks nothing like its cause.
const IP_FAMILY = Number(process.env.FB_IP_FAMILY ?? process.env.TONIC_IP_FAMILY ?? 4);
const dispatcher = IP_FAMILY === 0 ? undefined : new Agent({ connect: { family: IP_FAMILY } });
const withDispatcher = (init) => (dispatcher ? { ...init, dispatcher } : init);

/** Follow at most this many pages; a sane account never comes close. */
const MAX_PAGES = 25;

export class FacebookError extends Error {
  constructor(message, { status, code, subcode, type, traceId, path } = {}) {
    super(message);
    this.name = 'FacebookError';
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.type = type;
    this.traceId = traceId;
    this.path = path;
  }
}

/** Meta's errors are well structured; the hints are the part people need. */
function describeError(body, status) {
  const e = body?.error;
  if (!e) return `Facebook API error (HTTP ${status})`;

  let message = e.error_user_msg || e.message || `Facebook API error (HTTP ${status})`;
  if (e.code === 190) {
    message += ' — the access token is invalid or has expired. Generate a new one and save it on the FB Settings screen.';
  } else if (e.code === 100 && /act_/.test(String(e.message || ''))) {
    message += ' — check the ad account ID.';
  } else if (e.code === 4 || e.code === 17 || e.code === 613) {
    message += ' — Facebook is rate limiting this app. Wait a few minutes and try again.';
  } else if (/API access blocked/i.test(String(e.message || '')) || e.code === 10) {
    // Code 10 is about the *app*, not the token. Saying "add ads_read" here
    // sends people back to the token generator, which is the wrong place.
    message += ' — this is the app behind the token, not the token itself. '
      + 'In the Meta app dashboard, add the Marketing API product, and make sure the app '
      + 'and the ad account are in the same Business (otherwise the app needs Advanced Access '
      + 'for ads_read through App Review).';
  } else if (e.code === 200 || e.code === 272) {
    message += ' — the system user has not been assigned this ad account. '
      + 'Business Settings → System Users → Assigned Assets → Ad Accounts, with at least View performance.';
  }
  return message;
}

/** Turn fetch's opaque failures into something that names the cause. */
async function fetchOrExplain(url, init, path) {
  try {
    return await fetch(url, withDispatcher(init));
  } catch (err) {
    const causes = [];
    for (let c = err; c; c = c.cause) if (c.code || c.message) causes.push(c.code || c.message);
    const code = causes.find((c) => /^[A-Z_]+$/.test(String(c)));
    const hint = {
      ENOTFOUND: 'DNS could not resolve graph.facebook.com.',
      ETIMEDOUT: 'The connection timed out.',
      ECONNREFUSED: 'The connection was refused.',
      UND_ERR_CONNECT_TIMEOUT: 'The connection timed out before it was established — often a VPN advertising an unroutable IPv6 route. Set FB_IP_FAMILY=4.',
    }[code];
    throw new FacebookError(
      `Could not reach Facebook (${causes[0] || err.message})${hint ? ` — ${hint}` : ''}`,
      { path }
    );
  }
}

/** Accept 123, act_123 or a pasted "act_123" with stray spaces. */
export function normaliseAdAccountId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/^act_/i, '').replace(/\D/g, '');
  return digits ? `act_${digits}` : null;
}

export class FacebookClient {
  constructor({ accessToken, adAccountId, apiVersion } = {}) {
    this.accessToken = accessToken || null;
    this.adAccountId = normaliseAdAccountId(adAccountId);
    this.apiVersion = (apiVersion || DEFAULT_VERSION).trim();
  }

  /**
   * The token goes in the Authorization header, never the query string — a URL
   * ends up in logs and error messages, and this one would carry a credential.
   */
  async request(path, query = {}) {
    if (!this.accessToken) throw new FacebookError('No Facebook access token configured.', { status: 428 });

    const url = new URL(`${BASE}/${this.apiVersion}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    return this.requestUrl(url, path);
  }

  async requestUrl(url, path) {
    const res = await fetchOrExplain(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    }, path);

    const text = await res.text();
    let body = null;
    if (text) { try { body = JSON.parse(text); } catch { body = text; } }

    if (!res.ok) {
      const e = body?.error || {};
      throw new FacebookError(describeError(body, res.status), {
        status: res.status, code: e.code, subcode: e.error_subcode,
        type: e.type, traceId: e.fbtrace_id, path,
      });
    }
    return body;
  }

  /**
   * Prove the token works. Listing ad accounts does double duty: it fails
   * loudly if the token lacks ads_read, and it is the list the Final Data
   * screen needs anyway.
   */
  async verify() {
    const me = await this.request('/me', { fields: 'id,name' });
    const accounts = await this.getAdAccounts();
    return {
      user: me?.name || me?.id || null,
      accounts: accounts.length,
      first: accounts[0] || null,
    };
  }

  /**
   * Every ad account the token can read. An agency token can see a lot of
   * them, so this follows paging rather than taking the first page.
   */
  async getAdAccounts() {
    const out = [];
    let body = await this.request('/me/adaccounts', {
      fields: 'account_id,name,account_status,currency,timezone_name',
      limit: 200,
    });

    let pages = 0;
    while (body && pages < MAX_PAGES) {
      for (const a of body.data || []) {
        out.push({
          id: `act_${a.account_id}`,
          accountId: String(a.account_id),
          name: a.name || `act_${a.account_id}`,
          currency: a.currency || null,
          timezone: a.timezone_name || null,
          // 1 is active; anything else means the account cannot spend.
          active: a.account_status === 1,
          accountStatus: a.account_status ?? null,
        });
      }
      pages += 1;
      const next = body.paging?.next;
      if (!next) break;
      body = await this.requestUrl(new URL(next), '/me/adaccounts');
    }

    out.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
    return out;
  }

  /**
   * Delivery status per adset. Insights does not carry it, so it comes from
   * the adsets edge and is merged in. `effective_status` is the one that
   * matters — an adset can be ACTIVE while its campaign is paused, and that
   * shows up here as CAMPAIGN_PAUSED rather than a misleading ACTIVE.
   */
  async getAdsetStatuses(accountId) {
    const account = normaliseAdAccountId(accountId) || this.adAccountId;
    if (!account) throw new FacebookError('No ad account selected.', { status: 428 });

    const byId = new Map();
    let body = await this.request(`/${account}/adsets`, {
      fields: 'id,name,status,effective_status',
      limit: 500,
    });

    let pages = 0;
    while (body && pages < MAX_PAGES) {
      for (const a of body.data || []) {
        byId.set(String(a.id), {
          status: a.status || null,
          effectiveStatus: a.effective_status || null,
        });
      }
      pages += 1;
      const next = body.paging?.next;
      if (!next) break;
      body = await this.requestUrl(new URL(next), '/adsets');
    }
    return byId;
  }

  /**
   * One row per adset for the whole range (time_increment=all_days), which is
   * what the Final Data table shows. Per-day rows would be 30x the volume for
   * a breakdown nothing currently displays.
   */
  async getAdsetInsights({ since, until, accountId }) {
    const account = normaliseAdAccountId(accountId) || this.adAccountId;
    if (!account) throw new FacebookError('No ad account selected.', { status: 428 });

    const rows = [];
    let body = await this.request(`/${account}/insights`, {
      level: 'adset',
      fields: 'adset_id,adset_name,campaign_id,campaign_name,spend,impressions,clicks',
      time_range: { since, until },
      time_increment: 'all_days',
      limit: 500,
    });

    let pages = 0;
    while (body && pages < MAX_PAGES) {
      for (const r of body.data || []) {
        rows.push({
          adsetId: String(r.adset_id),
          adsetName: r.adset_name || null,
          campaignId: r.campaign_id != null ? String(r.campaign_id) : null,
          campaignName: r.campaign_name || null,
          spend: Number(r.spend) || 0,
          impressions: Number(r.impressions) || 0,
          clicks: Number(r.clicks) || 0,
        });
      }
      pages += 1;
      const next = body.paging?.next;
      if (!next) break;
      body = await this.requestUrl(new URL(next), '/insights');
    }

    return { rows, truncated: pages >= MAX_PAGES };
  }
}
