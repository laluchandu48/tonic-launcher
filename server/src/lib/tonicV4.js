/**
 * Client for the TONIC. for Publishers API v4 (spec 4.16.1).
 * Base: https://api.publisher.tonic.com/v4
 *
 * v4 is a different API from v3, not a version bump of the same one:
 *   - credentials are camelCase (consumerKey / consumerSecret), v3 used snake_case
 *   - it issues an access token AND a refresh token, each with its own expiry
 *   - every response is wrapped in { data, warnings, pagination, sorting }
 *   - list endpoints take limit/offset and return pagination metadata
 *
 * The v3 client stays in place for the screens already built on it; this one is
 * additive, so nothing that currently works has to change to add a v4 feature.
 */

import { Agent } from 'undici';

const BASE_URL = process.env.TONIC_V4_BASE_URL || 'https://api.publisher.tonic.com/v4';
const REFRESH_MARGIN_MS = 60_000;

/**
 * Force IPv4 unless told otherwise.
 *
 * Windows' resolver hands Node an AAAA record first, and on a machine running a
 * VPN that advertises IPv6 without routing it (Tailscale, among others) every
 * request then hangs until the connect timeout. Browsers and curl hide this by
 * falling back to IPv4; Node does not, so the whole app appears to lose its
 * network while everything else on the machine works.
 *
 * Tonic is reachable over IPv4, so pinning the family costs nothing and removes
 * a failure mode that looks nothing like its cause. Set TONIC_IP_FAMILY=0 to
 * restore normal dual-stack behaviour, or 6 to force IPv6.
 */
const IP_FAMILY = Number(process.env.TONIC_IP_FAMILY ?? 4);
const dispatcher = IP_FAMILY === 0 ? undefined : new Agent({ connect: { family: IP_FAMILY } });

/** Merge the dispatcher into a fetch init without overwriting what a caller set. */
const withDispatcher = (init) => (dispatcher ? { ...init, dispatcher } : init);

export class TonicV4Error extends Error {
  constructor(message, { status, path, body, requestId } = {}) {
    super(message);
    this.name = 'TonicV4Error';
    this.status = status;
    this.path = path;
    this.body = body;
    this.requestId = requestId;
  }
}

async function parseBody(res) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

/** v4 errors come back as { status, details, requestId } rather than a bare string. */
function describeError(body, status) {
  if (!body) return `Tonic API error (HTTP ${status})`;
  if (typeof body === 'string') return body;

  const details = body.details;

  // `details` comes back in three different shapes depending on the endpoint:
  // a plain sentence (auth failures), an array of {parameterName, message}
  // (validation), or an object keyed by field name (per the spec's examples).
  if (typeof details === 'string' && details.trim()) return details.trim();

  if (Array.isArray(details)) {
    const parts = details
      .map((d) => (typeof d === 'string' ? d : [d?.parameterName, d?.message].filter(Boolean).join(': ')))
      .filter(Boolean);
    if (parts.length) return parts.join('; ');
  } else if (details && typeof details === 'object') {
    const parts = Object.entries(details)
      .map(([field, msgs]) => `${field}: ${Array.isArray(msgs) ? msgs.join(', ') : msgs}`);
    if (parts.length) return parts.join('; ');
  }

  return body.message || body.error
    || (typeof body.status === 'string' ? body.status : null)
    || `Tonic API error (HTTP ${status})`;
}


/**
 * Node reports every network-level failure as a bare "fetch failed" and hides
 * the real reason on error.cause — DNS, refused connection, TLS, timeout. That
 * message alone is undiagnosable, so unwrap the chain here.
 */
async function fetchOrExplain(url, init, path) {
  try {
    return await fetch(url, withDispatcher(init));
  } catch (err) {
    const chain = [];
    for (let e = err; e; e = e.cause) {
      const bit = e.code || e.message;
      if (bit && !chain.includes(bit)) chain.push(bit);
    }
    const code = chain.find((c) => /^[A-Z_]+$/.test(c)) || '';
    const hint = {
      ENOTFOUND: 'DNS could not resolve api.publisher.tonic.com — check the machine is online.',
      EAI_AGAIN: 'DNS lookup timed out — the network may be down or behind a captive portal.',
      ECONNREFUSED: 'The connection was refused.',
      ECONNRESET: 'The connection was reset, often a proxy or firewall closing it.',
      ETIMEDOUT: 'The connection timed out — a firewall or proxy may be blocking outbound HTTPS.',
      UND_ERR_CONNECT_TIMEOUT: 'The connection timed out before it was established.',
      CERT_HAS_EXPIRED: 'The TLS certificate was rejected.',
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS verification failed, typical of an intercepting proxy.',
    }[code];

    throw new TonicV4Error(
      `Could not reach Tonic (${chain.join(' → ') || 'unknown network error'})`
      + (hint ? ` ${hint}` : ''),
      { status: 0, path, body: null },
    );
  }
}

export class TonicV4Client {
  constructor({ consumerKey, consumerSecret }) {
    if (!consumerKey || !consumerSecret) {
      throw new TonicV4Error('Tonic API credentials are not configured.');
    }
    this.consumerKey = consumerKey;
    this.consumerSecret = consumerSecret;
    this.accessToken = null;
    this.accessExpiresAt = 0;
    this.refreshToken = null;
    this.refreshExpiresAt = 0;
    this._pending = null;
  }

  get tokenIsFresh() {
    return Boolean(this.accessToken) && Date.now() < this.accessExpiresAt - REFRESH_MARGIN_MS;
  }

  _storeTokens(data) {
    const access = data?.accessToken;
    const refresh = data?.refreshToken;
    if (!access?.token) {
      throw new TonicV4Error('Authentication succeeded but no access token was returned.');
    }
    this.accessToken = access.token;
    // `expires` is a unix timestamp in seconds.
    this.accessExpiresAt = access.expires ? access.expires * 1000 : Date.now() + 15 * 60_000;
    if (refresh?.token) {
      this.refreshToken = refresh.token;
      this.refreshExpiresAt = refresh.expires ? refresh.expires * 1000 : 0;
    }
    return this.accessToken;
  }

  async authenticate({ force = false } = {}) {
    if (!force && this.tokenIsFresh) return this.accessToken;
    if (this._pending) return this._pending;

    this._pending = (async () => {
      // Spend the refresh token when we have a live one — cheaper than a full
      // re-auth and it keeps the credential pair out of the request.
      if (!force && this.refreshToken && Date.now() < this.refreshExpiresAt - REFRESH_MARGIN_MS) {
        try {
          const res = await fetchOrExplain(`${BASE_URL}/jwt/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.refreshToken}` },
            body: JSON.stringify({ refreshToken: this.refreshToken }),
          }, '/jwt/refresh');
          if (res.ok) {
            const body = await parseBody(res);
            return this._storeTokens(body?.data ?? body);
          }
        } catch {
          // Fall through to a full authentication.
        }
      }

      const res = await fetchOrExplain(`${BASE_URL}/jwt/authenticate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consumerKey: this.consumerKey, consumerSecret: this.consumerSecret }),
      }, '/jwt/authenticate');
      const body = await parseBody(res);
      if (!res.ok) {
        throw new TonicV4Error(describeError(body, res.status), {
          status: res.status, path: '/jwt/authenticate', body,
          requestId: body?.requestId,
        });
      }
      return this._storeTokens(body?.data ?? body);
    })().finally(() => { this._pending = null; });

    return this._pending;
  }

  /**
   * Returns { data, pagination, warnings } rather than the raw envelope, so
   * callers never have to know the wrapper exists.
   */
  async request(method, path, { query, body, _retried = false } = {}) {
    const token = await this.authenticate();
    const url = new URL(BASE_URL + path);

    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === '') continue;
      // Several v4 filters take comma-separated lists.
      url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }

    const res = await fetchOrExplain(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, url.pathname);
    const payload = await parseBody(res);

    if (res.status === 401 && !_retried) {
      await this.authenticate({ force: true });
      return this.request(method, path, { query, body, _retried: true });
    }

    if (!res.ok) {
      throw new TonicV4Error(describeError(payload, res.status), {
        status: res.status, path: url.pathname, body: payload,
        requestId: payload?.requestId,
      });
    }

    return {
      data: payload?.data ?? null,
      pagination: payload?.pagination ?? null,
      warnings: payload?.warnings ?? null,
    };
  }

  // ─── Account & lookups ─────────────────────────────────────────────────────

  /** Also the source of availableRsocDomains — v3 had a dedicated domains endpoint. */
  getAccount() {
    return this.request('GET', '/account');
  }

  /** Offers, optionally narrowed to a country and/or an RSOC domain. */
  getOffers({ countryCode, domain, campaignType = 'rsoc' } = {}) {
    return this.request('GET', '/offers', { query: { campaignType, countryCode, domain } });
  }

  getCountries({ domain, campaignType = 'rsoc' } = {}) {
    return this.request('GET', '/countries', { query: { campaignType, domain } });
  }

  // ─── Articles ──────────────────────────────────────────────────────────────

  /** Published articles — the v3 "headlines" feed. An article's id creates a campaign. */
  getArticles(query) {
    return this.request('GET', '/articles', { query });
  }

  getArticle(id) {
    return this.request('GET', `/articles/${encodeURIComponent(id)}`);
  }

  /** Refused with 409 while any campaign still uses the article. */
  deleteArticle(id) {
    return this.request('DELETE', `/articles/${encodeURIComponent(id)}`);
  }

  getArticleRequests(query) {
    return this.request('GET', '/articles/requests', { query });
  }

  getArticleRequest(id) {
    return this.request('GET', `/articles/requests/${encodeURIComponent(id)}`);
  }

  /**
   * v4 renames most of this payload: phrases (was content_generation_phrases),
   * title (was headline), citationLink (was a citation_links array),
   * countryCode and offerId.
   */
  createArticleRequest(payload) {
    return this.request('POST', '/articles/requests', { body: payload });
  }

  // ─── Campaigns ─────────────────────────────────────────────────────────────

  /**
   * `state` is required. With stats=true and a from/to range (max 31 days) each
   * row carries views, clicks, vtc, revenue, rpc and rpmv — the metrics this app
   * used to assemble by hand from two separate v3 reports.
   */
  getCampaigns({ state = 'active', stats, from, to, ...rest } = {}) {
    return this.request('GET', '/campaigns', {
      query: { state, stats: stats ? 'true' : undefined, from, to, ...rest },
    });
  }

  /** Grouped by day or month. Day allows 31 days, month allows 186. */
  getCampaignPerformance({ state = 'active', grouping = 'day', from, to, ...rest } = {}) {
    return this.request('GET', '/campaigns/performance', {
      query: { state, grouping, from, to, ...rest },
    });
  }

  /** The article carries the offer and country, so neither is passed separately. */
  createCampaign({ name, articleId, imprint }) {
    const body = { name, articleId: Number(articleId) };
    if (imprint !== undefined) body.imprint = Boolean(imprint);
    return this.request('POST', '/campaigns', { body });
  }

  /**
   * One endpoint for what v3 spread across rename, keywords, callback and
   * status. Takes an array, so several campaigns can be updated in one call.
   * Each dataset must carry its own id.
   */
  patchCampaigns(datasets) {
    return this.request('PATCH', '/campaigns', {
      body: Array.isArray(datasets) ? datasets : [datasets],
    });
  }

  // ─── Statistics ────────────────────────────────────────────────────────────

  /** lastFinalDate, lastClosedMonth, finalizedOn. */
  getStatisticsStatus() {
    return this.request('GET', '/statistics/status');
  }

  /** One day of session rows, paginated — replaces v3's session/daily. */
  getSessionReport({ date, campaignType = 'rsoc', ...rest }) {
    return this.request('GET', '/analytics/reports/session', {
      query: { date, campaignType, ...rest },
    });
  }

  // ─── Compliance ────────────────────────────────────────────────────────────

  /** Ad IDs with their allowed/declined status, explanation and revenue. */
  getAdIds(query) {
    return this.request('GET', '/compliance/adIds', { query: { withCampaignName: true, ...query } });
  }

  /** Status transitions. The API caps the date range at 3 days. */
  getAdIdChangeLog(query) {
    return this.request('GET', '/compliance/adIds/changeLog', { query });
  }

  getAdIdDetail(id) {
    return this.request('GET', `/compliance/adIds/${encodeURIComponent(id)}`);
  }

  /** Ask Tonic to reconsider a declined ad. Message must be 10-500 characters. */
  sendReviewRequest({ campaignId, adId, message }) {
    return this.request('POST', '/compliance/adIds/reviewRequest', {
      body: { campaignId: Number(campaignId), adId: String(adId), message },
    });
  }

  /** Site IDs Tonic blocks network-wide. */
  getSiteIds(query) {
    return this.request('GET', '/compliance/siteIds', { query });
  }

  /** Non-compliant site IDs detected in your own traffic. */
  getDetectedSiteIds(query) {
    return this.request('GET', '/compliance/siteIds/detected', { query });
  }

  /** Network clicks vs redirects Tonic actually saw — the deviation check. */
  getTrafficCheck(query) {
    return this.request('GET', '/compliance/trafficCheck', { query });
  }

  /** Campaigns missing or misusing required URL parameters. */
  getParameterCompliance(query) {
    return this.request('GET', '/compliance/parameter', { query });
  }
}

export { BASE_URL as V4_BASE_URL };
