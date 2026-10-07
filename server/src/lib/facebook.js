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

/**
 * Meta reports leads under several action types. `lead` is the aggregate across
 * every source, so it is preferred; the others are fallbacks for accounts that
 * only ever fire one of them. Summing all of them would double-count, because
 * the aggregate already contains the specific ones.
 */
const LEAD_ACTION_PRIORITY = [
  'lead',
  'offsite_conversion.fb_pixel_lead',
  'onsite_conversion.lead_grouped',
  'leadgen_grouped',
];

/**
 * Budgets come back as integers in the account currency's minor unit — cents
 * for USD, paise for INR. A few currencies have no minor unit at all, and
 * dividing those by 100 would understate a budget a hundredfold.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'JPY', 'KRW', 'VND', 'CLP', 'ISK', 'TWD', 'COP', 'PYG', 'UGX', 'RWF',
  'XAF', 'XOF', 'XPF', 'KMF', 'DJF', 'GNF', 'BIF', 'VUV',
]);

export const minorUnitsPerUnit = (currency) =>
  ZERO_DECIMAL_CURRENCIES.has(String(currency || '').toUpperCase()) ? 1 : 100;

/** Pick the lead count without double-counting overlapping action types. */
function leadsFrom(actions) {
  if (!Array.isArray(actions)) return 0;
  for (const type of LEAD_ACTION_PRIORITY) {
    const hit = actions.find((a) => a.action_type === type);
    if (hit) return Number(hit.value) || 0;
  }
  return 0;
}

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
  } else if (e.code === 4 || e.code === 17 || e.code === 613 || e.code === 80004) {
    message += ' — Facebook is rate limiting this app. Apps on the Marketing API\'s '
      + 'development access tier are held to roughly one call at a time; the limit lifts '
      + 'once the app is granted Standard or Advanced access.';
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
    // Every call goes through this chain, so only one is ever in flight.
    this._queue = Promise.resolve();
    this._accountCache = new Map();
  }

  /**
   * Run a call with no other Facebook call in flight.
   *
   * An app on the Marketing API's development access tier is held to **one
   * concurrent request**, so firing insights, adsets, campaigns and account
   * info together — the obvious thing to do, since they are independent — is
   * exactly what trips error 613. Serialising costs a little wall-clock time
   * and removes the failure entirely.
   */
  _serialise(run) {
    const next = this._queue.then(run, run);
    // Keep the chain alive regardless of outcome; a rejection here must not
    // poison every later call.
    this._queue = next.then(() => undefined, () => undefined);
    return next;
  }

  /** Back off and retry the throttling errors, which are worth waiting out. */
  async _withRetry(run, attempts = 3) {
    for (let i = 0; ; i += 1) {
      try {
        return await run();
      } catch (err) {
        const throttled = err instanceof FacebookError && [4, 17, 613, 80004].includes(err.code);
        if (!throttled || i >= attempts - 1) throw err;
        // 2s, then 8s. Long enough to clear a burst, short enough that a page
        // load does not look hung.
        await new Promise((r) => setTimeout(r, 2000 * 4 ** i));
      }
    }
  }

  /**
   * The token goes in the Authorization header, never the query string — a URL
   * ends up in logs and error messages, and this one would carry a credential.
   */
  async request(path, query = {}, { method = 'GET' } = {}) {
    if (!this.accessToken) throw new FacebookError('No Facebook access token configured.', { status: 428 });

    const url = new URL(`${BASE}/${this.apiVersion}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    return this.requestUrl(url, path, { method });
  }

  async requestUrl(url, path, { method = 'GET' } = {}) {
    return this._serialise(() => this._withRetry(() => this._send(url, path, method)));
  }

  async _send(url, path, method) {
    const res = await fetchOrExplain(url, {
      method,
      headers: { Authorization: `Bearer ${this.accessToken}` },
    }, path);

    const text = await res.text();
    let body = null;
    if (text) { try { body = JSON.parse(text); } catch { body = text; } }

    if (res.ok && body?.error) {
      const e = body.error;
      throw new FacebookError(describeError(body, res.status), {
        status: 502, code: e.code, subcode: e.error_subcode,
        type: e.type, traceId: e.fbtrace_id, path,
      });
    }

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

  /** Just enough of the account to render money correctly. */
  async getAccountInfo(accountId) {
    const account = normaliseAdAccountId(accountId) || this.adAccountId;
    if (!account) throw new FacebookError('No ad account selected.', { status: 428 });

    const cached = this._accountCache.get(account);
    if (cached) return cached;

    const data = await this.request(`/${account}`, { fields: 'name,currency' });
    const info = {
      id: account,
      name: data?.name || null,
      currency: data?.currency || 'USD',
      minorUnits: minorUnitsPerUnit(data?.currency),
    };
    // A currency does not change. Caching it removes one call per page load.
    this._accountCache.set(account, info);
    return info;
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
  async getAdsetMeta(accountId) {
    const account = normaliseAdAccountId(accountId) || this.adAccountId;
    if (!account) throw new FacebookError('No ad account selected.', { status: 428 });

    const byId = new Map();
    let body = await this.request(`/${account}/adsets`, {
      fields: 'id,name,status,effective_status,daily_budget,lifetime_budget,campaign_id',
      limit: 500,
    });

    let pages = 0;
    while (body && pages < MAX_PAGES) {
      for (const a of body.data || []) {
        byId.set(String(a.id), {
          status: a.status || null,
          effectiveStatus: a.effective_status || null,
          // Both are null when the campaign holds the budget (Advantage
          // campaign budget). The UI shows that rather than offering an edit
          // that Meta would reject.
          dailyBudgetMinor: a.daily_budget != null ? Number(a.daily_budget) : null,
          lifetimeBudgetMinor: a.lifetime_budget != null ? Number(a.lifetime_budget) : null,
          campaignId: a.campaign_id != null ? String(a.campaign_id) : null,
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
   * Campaign-level budgets. With Advantage campaign budget (CBO) the adset
   * carries no budget of its own and Meta rejects an adset-level edit, so the
   * campaign is where the number lives and where it has to be changed.
   */
  async getCampaignMeta(accountId) {
    const account = normaliseAdAccountId(accountId) || this.adAccountId;
    if (!account) throw new FacebookError('No ad account selected.', { status: 428 });

    const byId = new Map();
    let body = await this.request(`/${account}/campaigns`, {
      fields: 'id,name,status,effective_status,daily_budget,lifetime_budget',
      limit: 500,
    });

    let pages = 0;
    while (body && pages < MAX_PAGES) {
      for (const c of body.data || []) {
        byId.set(String(c.id), {
          name: c.name || null,
          status: c.status || null,
          effectiveStatus: c.effective_status || null,
          dailyBudgetMinor: c.daily_budget != null ? Number(c.daily_budget) : null,
          lifetimeBudgetMinor: c.lifetime_budget != null ? Number(c.lifetime_budget) : null,
        });
      }
      pages += 1;
      const next = body.paging?.next;
      if (!next) break;
      body = await this.requestUrl(new URL(next), '/campaigns');
    }
    return byId;
  }

  /**
   * Change one adset's or campaign's daily budget. This is the only write the launcher makes
   * to Facebook, and it needs `ads_management` on the token — `ads_read` alone
   * returns a permissions error here while every other call keeps working.
   *
   * `amountMinor` is in the account currency's minor unit, because that is what
   * Meta stores and returns; converting at the edges keeps rounding out of the
   * middle of the app.
   */
  async setDailyBudget(nodeId, amountMinor) {
    // Both adsets and campaigns are edited the same way — POST to the node with
    // daily_budget — so one method covers CBO and adset-level budgets alike.
    // Validate rather than sanitise. Stripping characters out of an id turns a
    // typo into a write against some *other* object, which is far worse than a
    // rejected request.
    const id = String(nodeId || '').trim();
    if (!/^[A-Za-z0-9_]{1,64}$/.test(id)) {
      throw new FacebookError('Not a valid adset or campaign ID.', { status: 400 });
    }

    const amount = Math.round(Number(amountMinor));
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new FacebookError('The budget must be greater than zero.', { status: 400 });
    }

    try {
      await this.request(`/${id}`, { daily_budget: amount }, { method: 'POST' });
    } catch (err) {
      if (err instanceof FacebookError && [200, 10, 272, 294].includes(err.code)) {
        throw new FacebookError(
          'Facebook refused the change: this token can read the ad account but not change it. '
          + 'Budget edits need the ads_management permission — regenerate the system user token '
          + 'with ads_read and ads_management, then save it on the FB Settings screen.',
          { status: 403, code: err.code, traceId: err.traceId, path: err.path }
        );
      }
      throw err;
    }
    return { id, dailyBudgetMinor: amount };
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
      fields: 'adset_id,adset_name,campaign_id,campaign_name,spend,impressions,clicks,actions',
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
          leads: leadsFrom(r.actions),
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
