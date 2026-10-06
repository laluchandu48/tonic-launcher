/**
 * Final Data — Facebook spend joined to Tonic revenue.
 *
 * The join works because the Facebook adset ID is carried into the Tonic
 * tracking link as a querystring parameter (subid2 by default, configurable on
 * the FB Settings screen). Tonic's session report returns that parameter beside
 * each session's revenue, so grouping it gives revenue per adset, which lines up
 * with Facebook's own adset-level spend.
 *
 * Two deliberate choices:
 *
 *   - Facebook is asked for the whole range at once (time_increment=all_days).
 *     Tonic has to be asked day by day, because its session report takes a
 *     single date. Finished days are cached, so a 30-day view costs one Tonic
 *     call per day only the first time.
 *
 *   - Rows that match on neither side are reported rather than dropped. Spend
 *     with no revenue and revenue with no spend are both worth seeing, and a
 *     silently discarded row looks exactly like a losing adset.
 */
import { Router } from 'express';
import { asyncRoute, requireCredentials } from '../lib/http.js';
import { getV4Client } from '../lib/credentials.js';
import {
  getFbClient, readFbSettings, requireFbCredentials, rememberAdAccount,
} from '../lib/fbCredentials.js';
import { normaliseAdAccountId } from '../lib/facebook.js';
import { sessionDays } from '../db/index.js';

const router = Router();
router.use(requireCredentials, requireFbCredentials);

/** Tonic refuses a session report older than this. */
const MAX_LOOKBACK_DAYS = 50;
/** 1000 is Tonic's page cap; 40 pages is 40k sessions in one day. */
const PAGE_SIZE = 1000;
const MAX_PAGES = 40;

const DAY = 86_400_000;
const iso = (d) => d.toISOString().slice(0, 10);
const parseDay = (s) => new Date(`${s}T00:00:00Z`);

function eachDay(from, to) {
  const out = [];
  for (let t = parseDay(from).getTime(); t <= parseDay(to).getTime(); t += DAY) {
    out.push(iso(new Date(t)));
  }
  return out;
}

const round = (n, places = 2) => {
  const f = 10 ** places;
  return Math.round((Number(n) || 0) * f) / f;
};

/**
 * One day of Tonic sessions, aggregated by the join parameter.
 *
 * `estimation` is Tonic's revenue estimate for the session; `pre_estimation`
 * and `estimation_5h` are earlier, less settled numbers, so this uses the one
 * the dashboard also reports as revenue.
 */
async function fetchTonicDay(date, param) {
  const columns = ['campaign_id', 'clicks', 'estimation', `querystring.${param}`].join(',');
  const totals = new Map();
  let sessions = 0;
  let offset = 0;
  let pages = 0;

  while (pages < MAX_PAGES) {
    const { data } = await getV4Client().getSessionReport({
      date, columns, limit: PAGE_SIZE, offset,
    });
    const rows = Array.isArray(data) ? data : [];

    for (const r of rows) {
      // Requested tracking parameters come back nested under `querystring`.
      const raw = r.querystring?.[param] ?? r[`querystring.${param}`] ?? r[param];
      const key = String(raw ?? '').trim() || '(not set)';
      const acc = totals.get(key) || { key, sessions: 0, clicks: 0, revenue: 0 };
      acc.sessions += 1;
      acc.clicks += Number(r.clicks) || 0;
      acc.revenue += Number(r.estimation) || 0;
      totals.set(key, acc);
    }

    sessions += rows.length;
    pages += 1;
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return { rows: [...totals.values()], sessions, truncated: pages >= MAX_PAGES };
}

/**
 * Fill the cache for the range. A day Tonic has finalised is fetched once and
 * kept; today and any still-open day are refetched every time.
 */
async function ensureTonicRange(from, to, param, lastFinalDate) {
  let fetched = 0;
  let cached = 0;
  const truncatedDays = [];

  for (const date of eachDay(from, to)) {
    const isFinal = Boolean(lastFinalDate) && date <= lastFinalDate;
    const known = sessionDays.status(date, param);

    if (known && known.complete && isFinal) {
      cached += 1;
      if (known.truncated) truncatedDays.push(date);
      continue;
    }

    const day = await fetchTonicDay(date, param);
    sessionDays.replaceDay(date, param, day.rows, {
      complete: isFinal ? 1 : 0,
      truncated: day.truncated ? 1 : 0,
      sessions: day.sessions,
    });
    fetched += 1;
    if (day.truncated) truncatedDays.push(date);
  }

  return { fetched, cached, truncatedDays };
}

router.get('/', asyncRoute(async (req, res) => {
  const stored = readFbSettings();
  const param = String(req.query.param || stored.joinParam).trim();

  // The ad account is chosen on the screen. Fall back to the last one used,
  // then to the first the token can see, so a fresh install still shows data.
  let accountId = normaliseAdAccountId(req.query.account) || stored.adAccountId;
  if (!accountId) {
    const accounts = await getFbClient().getAdAccounts();
    if (!accounts.length) {
      return res.status(428).json({
        error: 'This access token cannot see any ad accounts.',
        hint: 'Check that the token has the ads_read permission.',
        code: 'NO_FB_ACCOUNTS',
      });
    }
    accountId = accounts[0].id;
  }
  if (accountId !== stored.adAccountId) rememberAdAccount(accountId);

  const today = new Date();
  const floor = iso(new Date(today.getTime() - (MAX_LOOKBACK_DAYS - 1) * DAY));
  let from = String(req.query.from || iso(new Date(today.getTime() - 29 * DAY)));
  let to = String(req.query.to || iso(today));

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'Dates must be YYYY-MM-DD.' });
  }
  if (from > to) [from, to] = [to, from];

  const notes = [];
  if (from < floor) {
    notes.push(`Tonic's session report only goes back ${MAX_LOOKBACK_DAYS} days, so the range starts at ${floor}.`);
    from = floor;
  }

  // Tonic finalises revenue a day or two behind; anything after that date can
  // still move, which is worth saying rather than leaving people to discover.
  let lastFinalDate = null;
  try {
    const { data } = await getV4Client().getStatisticsStatus();
    lastFinalDate = data?.lastFinalDate || null;
  } catch {
    // Not fatal — it only decides what gets cached.
  }

  const [fb, statuses, tonicFill] = await Promise.all([
    getFbClient().getAdsetInsights({ since: from, until: to, accountId }),
    // Delivery status is not an Insights field, so it is fetched alongside and
    // merged. A failure here must not cost the whole report.
    getFbClient().getAdsetStatuses(accountId).catch(() => new Map()),
    ensureTonicRange(from, to, param, lastFinalDate),
  ]);

  const tonic = sessionDays.range(from, to, param);
  const byKey = new Map(tonic.map((r) => [String(r.key), r]));

  const rows = [];
  const matchedKeys = new Set();

  for (const ad of fb.rows) {
    const hit = byKey.get(ad.adsetId);
    if (hit) matchedKeys.add(ad.adsetId);

    const revenue = hit ? Number(hit.revenue) || 0 : 0;
    const profit = revenue - ad.spend;
    const delivery = statuses.get(ad.adsetId) || {};
    rows.push({
      adsetId: ad.adsetId,
      adsetName: ad.adsetName,
      // ACTIVE, PAUSED, CAMPAIGN_PAUSED, ARCHIVED and so on — effectiveStatus
      // accounts for the campaign above it, which plain status does not.
      status: delivery.effectiveStatus || delivery.status || null,
      campaignName: ad.campaignName,
      spend: round(ad.spend),
      impressions: ad.impressions,
      fbClicks: ad.clicks,
      sessions: hit ? hit.sessions : 0,
      tonicClicks: hit ? hit.clicks : 0,
      revenue: round(revenue),
      profit: round(profit),
      // ROI as a percentage of spend. Revenue with no spend has no ROI to
      // report, so it stays null rather than becoming a misleading infinity.
      roi: ad.spend > 0 ? round((profit / ad.spend) * 100, 1) : null,
      cpc: ad.clicks > 0 ? round(ad.spend / ad.clicks, 3) : null,
      epc: hit && hit.clicks > 0 ? round(revenue / hit.clicks, 3) : null,
      matched: Boolean(hit),
    });
  }

  rows.sort((a, b) => b.spend - a.spend || b.revenue - a.revenue);

  // Revenue Tonic reports under a key no Facebook adset claims: either traffic
  // from somewhere else, or the tracking link is not passing the adset id.
  const unmatched = tonic
    .filter((r) => !matchedKeys.has(String(r.key)))
    .map((r) => ({
      key: String(r.key),
      sessions: r.sessions,
      clicks: r.clicks,
      revenue: round(r.revenue),
    }))
    .sort((a, b) => b.revenue - a.revenue);

  const sum = (list, field) => list.reduce((n, r) => n + (Number(r[field]) || 0), 0);
  const spend = sum(rows, 'spend');
  const revenue = sum(rows, 'revenue');

  if (!rows.some((r) => r.matched) && tonic.length > 0) {
    notes.push(`No Facebook adset ID matched a Tonic "${param}" value. Check that your tracking link passes the adset ID in ${param}.`);
  }
  if (fb.truncated) notes.push('Facebook returned more pages of adsets than this fetches; totals may be low.');
  if (tonicFill.truncatedDays.length) {
    notes.push(`Some days had more sessions than one fetch covers (${tonicFill.truncatedDays.join(', ')}); revenue for them may be low.`);
  }
  if (lastFinalDate && to > lastFinalDate) {
    notes.push(`Tonic has finalised revenue through ${lastFinalDate}; anything after that is an estimate and can still change.`);
  }

  res.json({
    rows,
    unmatched,
    totals: {
      spend: round(spend),
      revenue: round(revenue),
      profit: round(revenue - spend),
      roi: spend > 0 ? round(((revenue - spend) / spend) * 100, 1) : null,
      impressions: sum(rows, 'impressions'),
      fbClicks: sum(rows, 'fbClicks'),
      tonicClicks: sum(rows, 'tonicClicks'),
      sessions: sum(rows, 'sessions'),
      unmatchedRevenue: round(sum(unmatched, 'revenue')),
    },
    meta: {
      from, to, param, lastFinalDate, accountId,
      daysFetched: tonicFill.fetched,
      daysFromCache: tonicFill.cached,
      adsets: rows.length,
      matched: rows.filter((r) => r.matched).length,
    },
    notes,
  });
}));

export default router;
