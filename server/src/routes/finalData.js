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
import { normaliseAdAccountId, minorUnitsPerUnit } from '../lib/facebook.js';
import { sessionDays } from '../db/index.js';

const router = Router();

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

router.get('/', requireCredentials, requireFbCredentials, asyncRoute(async (req, res) => {
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

  // Tonic and Facebook are different APIs with separate limits, so those two
  // run together. Within Facebook the client serialises calls itself — an app
  // on the development access tier allows only one at a time.
  const [fbSide, tonicFill] = await Promise.all([
    (async () => {
      const insights = await getFbClient().getAdsetInsights({ since: from, until: to, accountId });
      // Status and budget are not Insights fields, so they come from the
      // adsets and campaigns edges. A failure in either must not cost the
      // whole report — the numbers still stand without them.
      const meta = await getFbClient().getAdsetMeta(accountId).catch(() => new Map());
      const campaignMeta = await getFbClient().getCampaignMeta(accountId).catch(() => new Map());
      const account = await getFbClient().getAccountInfo(accountId)
        .catch(() => ({ currency: 'USD', minorUnits: 100 }));
      return { insights, meta, campaignMeta, account };
    })(),
    ensureTonicRange(from, to, param, lastFinalDate),
  ]);

  const { insights: fb, meta, campaignMeta, account } = fbSide;

  const minorUnits = account.minorUnits || minorUnitsPerUnit(account.currency);

  const tonic = sessionDays.range(from, to, param);
  const byKey = new Map(tonic.map((r) => [String(r.key), r]));

  const rows = [];
  const matchedKeys = new Set();

  for (const ad of fb.rows) {
    const hit = byKey.get(ad.adsetId);
    if (hit) matchedKeys.add(ad.adsetId);

    const revenue = hit ? Number(hit.revenue) || 0 : 0;
    const profit = revenue - ad.spend;
    const delivery = meta.get(ad.adsetId) || {};
    const campaign = (ad.campaignId && campaignMeta.get(ad.campaignId)) || {};

    /**
     * The budget belongs to whichever level actually holds it. An adset budget
     * wins when present; otherwise it is the campaign's, and editing it from
     * this row changes every adset under that campaign — which the row says so
     * the person is not surprised by it.
     */
    const budget = (() => {
      if (delivery.dailyBudgetMinor != null) {
        return { amount: delivery.dailyBudgetMinor, level: 'adset', type: 'daily', ownerId: ad.adsetId };
      }
      if (delivery.lifetimeBudgetMinor != null) {
        return { amount: delivery.lifetimeBudgetMinor, level: 'adset', type: 'lifetime', ownerId: ad.adsetId };
      }
      if (campaign.dailyBudgetMinor != null) {
        return { amount: campaign.dailyBudgetMinor, level: 'campaign', type: 'daily', ownerId: ad.campaignId };
      }
      if (campaign.lifetimeBudgetMinor != null) {
        return { amount: campaign.lifetimeBudgetMinor, level: 'campaign', type: 'lifetime', ownerId: ad.campaignId };
      }
      return null;
    })();
    // A conversion is a Tonic session click — the click on a sponsored listing
    // that actually earns the revenue.
    const conversions = hit ? hit.clicks : 0;

    rows.push({
      adsetId: ad.adsetId,
      adsetName: ad.adsetName,
      // ACTIVE, PAUSED, CAMPAIGN_PAUSED, ARCHIVED and so on — effectiveStatus
      // accounts for the campaign above it, which plain status does not.
      status: delivery.effectiveStatus || delivery.status || null,
      budget: budget ? round(budget.amount / minorUnits) : null,
      budgetLevel: budget?.level ?? null,     // 'adset' | 'campaign'
      budgetType: budget?.type ?? null,       // 'daily' | 'lifetime'
      budgetOwnerId: budget?.ownerId ?? null,
      campaignId: ad.campaignId,
      campaignName: ad.campaignName,
      spend: round(ad.spend),
      impressions: ad.impressions,
      clicks: ad.clicks,
      leads: ad.leads || 0,
      conversions,
      sessions: hit ? hit.sessions : 0,
      revenue: round(revenue),
      profit: round(profit),
      // ROI as a percentage of spend. Revenue with no spend has no ROI to
      // report, so it stays null rather than becoming a misleading infinity.
      roi: ad.spend > 0 ? round((profit / ad.spend) * 100, 1) : null,
      // Cost per conversion and revenue per conversion. Both are undefined
      // rather than zero when nothing converted — a blank reads as "no data",
      // a zero reads as "free", and only one of those is true.
      cpl: conversions > 0 ? round(ad.spend / conversions, 3) : null,
      rpc: conversions > 0 ? round(revenue / conversions, 3) : null,
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
      clicks: sum(rows, 'clicks'),
      leads: sum(rows, 'leads'),
      conversions: sum(rows, 'conversions'),
      sessions: sum(rows, 'sessions'),
      // A campaign budget is shared by every adset beneath it, so summing the
      // column would count it once per row. Count each owner once.
      budget: round(
        [...new Map(
          rows.filter((r) => r.budget != null && r.budgetType === 'daily')
              .map((r) => [r.budgetOwnerId, r.budget])
        ).values()].reduce((n, v) => n + v, 0)
      ),
      // Totals for the rates are computed from the totals, not averaged from
      // the rows — averaging rates weights a £1 adset the same as a £1,000 one.
      cpl: sum(rows, 'conversions') > 0 ? round(spend / sum(rows, 'conversions'), 3) : null,
      rpc: sum(rows, 'conversions') > 0 ? round(revenue / sum(rows, 'conversions'), 3) : null,
      unmatchedRevenue: round(sum(unmatched, 'revenue')),
    },
    meta: {
      from, to, param, lastFinalDate, accountId,
      currency: account.currency || 'USD',
      daysFetched: tonicFill.fetched,
      daysFromCache: tonicFill.cached,
      adsets: rows.length,
      matched: rows.filter((r) => r.matched).length,
    },
    notes,
  });
}));

/**
 * Change an adset's daily budget. This is the only endpoint in the app that
 * writes to an ad platform, so it is deliberately narrow: one adset, one field,
 * a positive number, and nothing else.
 */
router.put('/budget/:id', requireFbCredentials, asyncRoute(async (req, res) => {
  const amount = Number(req.body?.dailyBudget);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({
      error: 'Enter a daily budget greater than zero.',
      fields: { dailyBudget: 'Enter an amount greater than zero.' },
    });
  }

  const accountId = normaliseAdAccountId(req.body?.account) || readFbSettings().adAccountId;
  const account = await getFbClient().getAccountInfo(accountId);
  const minorUnits = account.minorUnits || minorUnitsPerUnit(account.currency);

  const result = await getFbClient().setDailyBudget(req.params.id, amount * minorUnits);
  res.json({
    ok: true,
    id: result.id,
    budget: round(result.dailyBudgetMinor / minorUnits),
    currency: account.currency,
  });
}));

/** Turn an adset on or off from its row. */
router.put('/adsets/:id/status', requireFbCredentials, asyncRoute(async (req, res) => {
  const active = req.body?.active;
  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: 'Send active: true or false.' });
  }
  const result = await getFbClient().setAdsetStatus(req.params.id, active);
  res.json({ ok: true, adsetId: result.id, status: result.status });
}));

export default router;
