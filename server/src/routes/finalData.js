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
  readDashboardAccounts,
} from '../lib/fbCredentials.js';
import { normaliseAdAccountId, minorUnitsPerUnit } from '../lib/facebook.js';
import { sessionDays } from '../db/index.js';
import { fetchTonicHours, TONIC_TZ } from '../lib/hourly.js';

const router = Router();

/**
 * A non-admin sees only the ad accounts assigned to them.
 *
 * Enforced on every route of this router rather than in each handler: the ad
 * account arrives as a query parameter, so "don't show them the picker" is
 * not a control — anyone can type a different ID into the URL. With no
 * account named, the first of theirs is used; with one named that is not
 * theirs, the request is refused rather than quietly answered about a
 * different account.
 */
router.use((req, res, next) => {
  /* Anyone who is not an admin — a viewer or an editor — is held to their
     assignment. Testing for "not admin" rather than naming the roles means a
     role added later is scoped by default instead of unscoped. */
  if (!req.user || req.user.role === 'admin') return next();

  const allowed = (req.user.adAccounts || []).map(normaliseAdAccountId).filter(Boolean);
  if (!allowed.length) {
    return res.status(403).json({
      error: 'No ad accounts have been assigned to this account yet.',
      code: 'NO_ASSIGNED_ACCOUNTS',
    });
  }

  /* "all" means every account assigned to them — still their own set, so it
     is not a way around the restriction. */
  if (String(req.query.account || '').trim().toLowerCase() === 'all') {
    req.allowedAccounts = allowed;
    req.query.account = 'all';
    return next();
  }

  const asked = normaliseAdAccountId(req.query.account);
  if (asked && !allowed.includes(asked)) {
    return res.status(403).json({ error: 'That ad account is not assigned to you.', code: 'FORBIDDEN' });
  }

  req.allowedAccounts = allowed;
  /* No account named means all of theirs, which is what the screen opens on.
     With one assigned account that is the same thing either way. */
  req.query.account = asked || (allowed.length > 1 ? 'all' : allowed[0]);
  next();
});

/**
 * Which ad account a request about one adset should use.
 *
 * "all" is not an account ID, and for a restricted user the stored account is
 * not necessarily one of theirs — falling back to it would answer about
 * somebody else's account. The guard above has already refused any account
 * they were not assigned, so what arrives here is either theirs or unset.
 */
function accountFor(req, asked) {
  const id = normaliseAdAccountId(asked);
  const allowed = req.allowedAccounts;
  if (allowed) return id && allowed.includes(id) ? id : allowed[0];
  return id || readFbSettings().adAccountId;
}

/**
 * How many ad accounts the "all" view will fetch at once.
 *
 * Each one costs four Facebook calls, taken one at a time, so this is the
 * line between a page and a wait.
 */
const MAX_ALL_ACCOUNTS = 5;

/** Tonic refuses a session report older than this. */
const MAX_LOOKBACK_DAYS = 50;
/** 1000 is Tonic's page cap; 40 pages is 40k sessions in one day. */
const PAGE_SIZE = 1000;
const MAX_PAGES = 40;

const DAY = 86_400_000;
const iso = (d) => d.toISOString().slice(0, 10);
const parseDay = (s) => new Date(`${s}T00:00:00Z`);

/**
 * The dashboard only started collecting on this date, so a range reaching
 * further back can add nothing but rows of zeros — and, on the Tonic side, one
 * wasted session-report call per empty day. Set DATA_START_DATE to move it.
 */
const DATA_START_DATE = String(process.env.DATA_START_DATE || '2026-10-08').slice(0, 10);

const maxDate = (a, b) => (a > b ? a : b);
/** The earliest date either API can usefully be asked about. */
const rangeFloor = (today) =>
  maxDate(DATA_START_DATE, iso(new Date(today.getTime() - (MAX_LOOKBACK_DAYS - 1) * DAY)));
/** Say which of the two limits moved the start, because they move it for different reasons. */
const floorNote = (floor) => (floor === DATA_START_DATE
  ? `This dashboard started collecting on ${DATA_START_DATE}, so the range starts there.`
  : `Tonic's session report only goes back ${MAX_LOOKBACK_DAYS} days, so the range starts at ${floor}.`);

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
/**
 * Tonic's session report has a maximum date, and it is normally yesterday —
 * the current day is not reportable until Tonic closes it. Asking for it fails
 * the request outright ("later than the maximum date"), which took the whole
 * screen down over a day that simply has no numbers yet.
 */
const BEYOND_TONIC_MAX = /later than the maximum date/i;

async function ensureTonicRange(from, to, param, lastFinalDate) {
  let fetched = 0;
  let cached = 0;
  const truncatedDays = [];
  const unreported = [];

  for (const date of eachDay(from, to)) {
    const isFinal = Boolean(lastFinalDate) && date <= lastFinalDate;
    const known = sessionDays.status(date, param);

    if (known && known.complete && isFinal) {
      cached += 1;
      if (known.truncated) truncatedDays.push(date);
      continue;
    }

    let day;
    try {
      day = await fetchTonicDay(date, param);
    } catch (err) {
      /* Only the "not reportable yet" case is swallowed. A day Tonic cannot
         report yet counts as zero rather than as a failure, and is stored
         incomplete so it fills in for real once Tonic has it. Any other error
         is a genuine problem and still travels. */
      if (!BEYOND_TONIC_MAX.test(err?.message || '')) throw err;
      day = { rows: [], sessions: 0, truncated: false };
      unreported.push(date);
    }

    sessionDays.replaceDay(date, param, day.rows, {
      complete: isFinal ? 1 : 0,
      truncated: day.truncated ? 1 : 0,
      sessions: day.sessions,
    });
    fetched += 1;
    if (day.truncated) truncatedDays.push(date);
  }

  return { fetched, cached, truncatedDays, unreported };
}

router.get('/', requireCredentials, requireFbCredentials, asyncRoute(async (req, res) => {
  const stored = readFbSettings();
  const param = String(req.query.param || stored.joinParam).trim();

  /* "all" is a restricted user asking for every account assigned to them —
     the guard above has already established that set. It is not an account ID,
     so it has to be recognised before normalising, which would turn it into
     null and quietly fall back to whichever account was stored last. Only
     honoured when there is an assigned set: for an admin, "all" would mean
     every account the token can see, which is far too many to fetch. */
  const askedAll = String(req.query.account || '').trim().toLowerCase() === 'all'
    && Array.isArray(req.allowedAccounts) && req.allowedAccounts.length > 0;

  // Otherwise the ad account is chosen on the screen. Fall back to the last
  // one used, then to the first the token can see, so a fresh install shows data.
  let accountId = askedAll ? 'all' : (normaliseAdAccountId(req.query.account) || stored.adAccountId);
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
  /* Remembering is for the admin's own picker. "all" is not an account, and a
     restricted user's choice is theirs alone — writing it here would move the
     admin's default to whatever a viewer last looked at. */
  if (!askedAll && !req.allowedAccounts && accountId !== stored.adAccountId) {
    rememberAdAccount(accountId);
  }

  const today = new Date();
  const floor = rangeFloor(today);
  let from = String(req.query.from || maxDate(iso(new Date(today.getTime() - 29 * DAY)), floor));
  let to = String(req.query.to || iso(today));

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'Dates must be YYYY-MM-DD.' });
  }
  if (from > to) [from, to] = [to, from];

  const notes = [];
  if (from < floor) {
    notes.push(floorNote(floor));
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
  /* Normally one account. A restricted user may ask for every account
     assigned to them, which is still their own set — not a way around the
     restriction, just a combined view of it. */
  const wantsAll = accountId === 'all';
  const assigned = req.allowedAccounts || [];
  const accountIds = wantsAll ? assigned.slice(0, MAX_ALL_ACCOUNTS) : [accountId];

  if (wantsAll && assigned.length > MAX_ALL_ACCOUNTS) {
    notes.push(
      `Showing the first ${MAX_ALL_ACCOUNTS} of your ${assigned.length} ad accounts. `
      + 'Each one costs four Facebook calls, so fetching them all at once takes too long '
      + 'to be useful — pick an account from the list to see the rest.'
    );
  }

  const [perAccount, tonicFill] = await Promise.all([
    (async () => {
      const out = [];
      for (const id of accountIds) {
        // Serial on purpose: the development access tier allows about one
        // Facebook call at a time, and a burst here is what produced #613.
        const insights = await getFbClient().getAdsetInsights({ since: from, until: to, accountId: id });
        // Status and budget are not Insights fields, so they come from the
        // adsets and campaigns edges. A failure in either must not cost the
        // whole report — the numbers still stand without them.
        const meta = await getFbClient().getAdsetMeta(id).catch(() => new Map());
        const campaignMeta = await getFbClient().getCampaignMeta(id).catch(() => new Map());
        const account = await getFbClient().getAccountInfo(id)
          .catch(() => ({ id, name: id, currency: 'USD', minorUnits: 100 }));
        out.push({ id, insights, meta, campaignMeta, account });
      }
      return out;
    })(),
    ensureTonicRange(from, to, param, lastFinalDate),
  ]);

  /* Flattened with each adset carrying the account it came from, so the loop
     below reads the same whether this is one account or five. */
  const allAds = perAccount.flatMap((slice) =>
    slice.insights.rows.map((ad) => ({ ...ad, slice })));

  const tonic = sessionDays.range(from, to, param);
  const byKey = new Map(tonic.map((r) => [String(r.key), r]));

  const rows = [];
  const matchedKeys = new Set();

  for (const ad of allAds) {
    const { meta, campaignMeta, account } = ad.slice;
    const minorUnits = account.minorUnits || minorUnitsPerUnit(account.currency);

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
      // Which account this row belongs to — only interesting in the combined
      // view, but harmless and cheap to carry in the single-account one.
      accountId: account.id || ad.slice.id,
      accountName: account.name || ad.slice.id,
      currency: account.currency || 'USD',
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

  const currencies = [...new Set(perAccount.map((slice) => slice.account.currency || 'USD'))];
  if (currencies.length > 1) {
    /* Adding £1 to €1 gives 2 of nothing. The rows stay, each labelled with
       its own currency, and the total says it cannot be trusted rather than
       printing a number that looks authoritative. */
    notes.push(
      `These accounts bill in different currencies (${currencies.join(', ')}), so the spend, `
      + 'profit and ROI totals below add up amounts that are not the same unit. Read the rows, '
      + 'not the total, or pick one account.'
    );
  }

  const sum = (list, field) => list.reduce((n, r) => n + (Number(r[field]) || 0), 0);
  const spend = sum(rows, 'spend');
  const revenue = sum(rows, 'revenue');

  if (!rows.some((r) => r.matched) && tonic.length > 0) {
    notes.push(`No Facebook adset ID matched a Tonic "${param}" value. Check that your tracking link passes the adset ID in ${param}.`);
  }
  if (perAccount.some((slice) => slice.insights.truncated)) {
    notes.push('Facebook returned more pages of adsets than this fetches; totals may be low.');
  }
  if (tonicFill.truncatedDays.length) {
    notes.push(`Some days had more sessions than one fetch covers (${tonicFill.truncatedDays.join(', ')}); revenue for them may be low.`);
  }
  if (lastFinalDate && to > lastFinalDate) {
    notes.push(`Tonic has finalised revenue through ${lastFinalDate}; anything after that is an estimate and can still change.`);
  }
  if (tonicFill.unreported.length) {
    notes.push(unreportedNote(tonicFill.unreported));
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
      from, to, dataStart: DATA_START_DATE, param, lastFinalDate, accountId,
      /* One currency when every account shares it, otherwise none — the page
         then labels each row rather than implying a single unit. */
      currency: currencies.length === 1 ? currencies[0] : null,
      currencies,
      accounts: perAccount.map((slice) => ({
        id: slice.account.id || slice.id,
        name: slice.account.name || slice.id,
        currency: slice.account.currency || 'USD',
      })),
      combined: wantsAll,
      daysFetched: tonicFill.fetched,
      daysFromCache: tonicFill.cached,
      adsets: rows.length,
      matched: rows.filter((r) => r.matched).length,
    },
    notes,
  });
}));

/**
 * Refuse a write against an object outside the caller's assignment.
 *
 * An adset ID is all the Graph API needs, so scoping the report alone would
 * leave an editor able to pause any adset whose ID they happen to know. One
 * extra Facebook call on a write is worth that. An admin is not restricted,
 * and the call is skipped for them.
 */
async function denyForeignObject(req, objectId) {
  const allowed = req.allowedAccounts;
  if (!allowed) return null;
  let owner;
  try {
    owner = await getFbClient().getOwningAccount(objectId);
  } catch {
    /* If Facebook will not say who owns it, the change does not happen. The
       safe answer to "I cannot tell" is no. */
    return 'That change could not be checked against your ad accounts.';
  }
  if (!owner || !allowed.includes(owner)) {
    return 'That adset is not in one of your ad accounts.';
  }
  return null;
}

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

  /* The budget may sit on the campaign rather than the adset, so :id is
     whichever object holds it — and either way it must be one of theirs. */
  const denied = await denyForeignObject(req, req.params.id);
  if (denied) {
    return res.status(403).json({
      error: denied.replace('That adset', 'That budget'),
      code: 'FORBIDDEN',
    });
  }

  const accountId = accountFor(req, req.body?.account);
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

/**
 * One adset, day by day.
 *
 * Same columns as the main table, one row per day, with a total at the end.
 * Both sides are already available per day — Facebook with time_increment=1,
 * Tonic because the cache is keyed by date — so this is a merge, not a new
 * kind of query.
 */
router.get('/adsets/:id/history', requireCredentials, requireFbCredentials, asyncRoute(async (req, res) => {
  const stored = readFbSettings();
  const param = String(req.query.param || stored.joinParam).trim();
  const adsetId = String(req.params.id);

  const today = new Date();
  const floor = rangeFloor(today);
  let from = String(req.query.from || maxDate(iso(new Date(today.getTime() - 29 * DAY)), floor));
  let to = String(req.query.to || iso(today));

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'Dates must be YYYY-MM-DD.' });
  }
  if (from > to) [from, to] = [to, from];

  const notes = [];
  if (from < floor) {
    notes.push(floorNote(floor));
    from = floor;
  }

  const accountId = accountFor(req, req.query.account);

  let lastFinalDate = null;
  try {
    const { data } = await getV4Client().getStatisticsStatus();
    lastFinalDate = data?.lastFinalDate || null;
  } catch { /* only decides what gets cached */ }

  const [fbSide, tonicFill] = await Promise.all([
    (async () => {
      const days = await getFbClient().getAdsetDailyInsights({ adsetId, since: from, until: to });
      const meta = await getFbClient().getAdsetMeta(accountId).catch(() => new Map());
      const account = await getFbClient().getAccountInfo(accountId)
        .catch(() => ({ currency: 'USD', minorUnits: 100 }));
      return { days, meta, account };
    })(),
    ensureTonicRange(from, to, param, lastFinalDate),
  ]);

  const { days, meta, account } = fbSide;
  const minorUnits = account.minorUnits || minorUnitsPerUnit(account.currency);
  const delivery = meta.get(adsetId) || {};

  // Tonic rows for this adset's key, by date.
  const tonicByDate = new Map(
    sessionDays.byKey(from, to, param, adsetId).map((r) => [r.date, r])
  );
  const fbByDate = new Map(days.map((d) => [d.date, d]));

  // Every day in the range, so a zero-spend day is visible as a gap rather
  // than silently missing from the sequence.
  const rows = eachDay(from, to).map((date) => {
    const fb = fbByDate.get(date) || { spend: 0, impressions: 0, clicks: 0, leads: 0 };
    const t = tonicByDate.get(date);
    const conversions = t ? t.clicks : 0;
    const revenue = t ? Number(t.revenue) || 0 : 0;
    const profit = revenue - fb.spend;

    return {
      date,
      spend: round(fb.spend),
      revenue: round(revenue),
      profit: round(profit),
      roi: fb.spend > 0 ? round((profit / fb.spend) * 100, 1) : null,
      cpl: conversions > 0 ? round(fb.spend / conversions, 3) : null,
      rpc: conversions > 0 ? round(revenue / conversions, 3) : null,
      leads: fb.leads,
      conversions,
      sessions: t ? t.sessions : 0,
      impressions: fb.impressions,
      clicks: fb.clicks,
      final: Boolean(lastFinalDate) && date <= lastFinalDate,
    };
  });

  if (tonicFill.unreported.length) {
    notes.push(unreportedNote(tonicFill.unreported));
  }

  const sum = (f) => rows.reduce((n, r) => n + (Number(r[f]) || 0), 0);
  const spend = sum('spend');
  const revenue = sum('revenue');
  const conversions = sum('conversions');

  res.json({
    adset: {
      id: adsetId,
      name: delivery.name || null,
      status: delivery.effectiveStatus || delivery.status || null,
      budget: delivery.dailyBudgetMinor != null ? round(delivery.dailyBudgetMinor / minorUnits) : null,
    },
    rows,
    totals: {
      spend: round(spend),
      revenue: round(revenue),
      profit: round(revenue - spend),
      roi: spend > 0 ? round(((revenue - spend) / spend) * 100, 1) : null,
      // From the totals, not an average of the daily rates.
      cpl: conversions > 0 ? round(spend / conversions, 3) : null,
      rpc: conversions > 0 ? round(revenue / conversions, 3) : null,
      leads: sum('leads'),
      conversions,
      sessions: sum('sessions'),
      impressions: sum('impressions'),
      clicks: sum('clicks'),
    },
    meta: { from, to, dataStart: DATA_START_DATE, param, accountId,
            currency: account.currency || 'USD', lastFinalDate,
            daysFetched: tonicFill.fetched, daysFromCache: tonicFill.cached },
    notes,
  });
}));

/** Turn an adset on or off from its row. */
router.put('/adsets/:id/status', requireFbCredentials, asyncRoute(async (req, res) => {
  const active = req.body?.active;
  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: 'Send active: true or false.' });
  }
  const denied = await denyForeignObject(req, req.params.id);
  if (denied) return res.status(403).json({ error: denied, code: 'FORBIDDEN' });

  const result = await getFbClient().setAdsetStatus(req.params.id, active);
  res.json({ ok: true, adsetId: result.id, status: result.status });
}));

/**
 * Every ad account at once — spend against the Tonic revenue that matched it.
 *
 * Deliberately lighter than the per-adset report above: no adset or campaign
 * meta, because budgets and delivery status are not part of this view. That
 * halves the Facebook calls per account, which matters. An app on the
 * development access tier allows roughly one call per 30 seconds, so the cost
 * here is linear in the number of accounts and measured in minutes — hence the
 * cache, and hence an explicit refresh rather than a fetch on every page load.
 */
/**
 * Fold one account's adset insights against the Tonic rows for the range.
 *
 * Exported because this is the arithmetic worth testing: everything else in
 * the handler is fetching and error handling.
 */
export function foldAccount(insightRows, byKey) {
  let spend = 0; let impressions = 0; let clicks = 0; let leads = 0;
  let revenue = 0; let conversions = 0; let matched = 0;

  for (const ad of insightRows) {
    spend += Number(ad.spend) || 0;
    impressions += Number(ad.impressions) || 0;
    clicks += Number(ad.clicks) || 0;
    leads += Number(ad.leads) || 0;

    const t = byKey.get(ad.adsetId);
    if (t) {
      matched += 1;
      revenue += Number(t.revenue) || 0;
      conversions += Number(t.clicks) || 0;
    }
  }

  return {
    adsets: insightRows.length,
    matched,
    spend: round(spend),
    revenue: round(revenue),
    profit: round(revenue - spend),
    roi: spend > 0 ? round(((revenue - spend) / spend) * 100, 1) : null,
    impressions,
    clicks,
    leads,
    conversions,
    /* Cost and revenue per Tonic session click. Null rather than zero when
       nothing converted: a blank reads as "no data", a zero reads as "free",
       and only one of those is true. Computed here so this screen and Final
       Data cannot drift apart on what CPL means. */
    cpl: conversions > 0 ? round(spend / conversions, 3) : null,
    rpc: conversions > 0 ? round(revenue / conversions, 3) : null,
  };
}

/**
 * Total the accounts whose spend can honestly be set against Tonic's USD
 * revenue. ROI comes from the summed spend and revenue, not from averaging the
 * per-account ROIs — an average would weight a $5 account the same as a $5,000
 * one and quietly report a figure nobody earned.
 */
export function totalsFrom(rows) {
  const sum = (f) => rows.reduce((n, r) => n + (Number(r[f]) || 0), 0);
  const spend = sum('spend');
  const revenue = sum('revenue');

  return {
    accounts: rows.length,
    spend: round(spend),
    revenue: round(revenue),
    profit: round(revenue - spend),
    roi: spend > 0 ? round(((revenue - spend) / spend) * 100, 1) : null,
    leads: sum('leads'),
    conversions: sum('conversions'),
    impressions: sum('impressions'),
    clicks: sum('clicks'),
    /* From the summed spend and revenue, not an average of the rows' own
       CPLs — a mean of ratios weights a tiny account like a large one. */
    cpl: sum('conversions') > 0 ? round(spend / sum('conversions'), 3) : null,
    rpc: sum('conversions') > 0 ? round(revenue / sum('conversions'), 3) : null,
    currency: 'USD',
  };
}

/** Said the same way wherever a day could not be asked for yet. */
const unreportedNote = (days) =>
  `Tonic has no session report yet for ${days.join(', ')}, so ${days.length === 1 ? 'that day is' : 'those days are'} counted as zero revenue. `
  + 'It usually closes a day the following morning.';

const SUMMARY_TTL_MS = 10 * 60_000;
const accountsSummary = new Map(); // `${from}|${to}|${param}` -> { at, payload }

router.get('/accounts', requireCredentials, requireFbCredentials, asyncRoute(async (req, res) => {
  const stored = readFbSettings();
  const param = String(req.query.param || stored.joinParam).trim();

  const today = new Date();
  const floor = rangeFloor(today);
  let from = String(req.query.from || iso(today));
  let to = String(req.query.to || iso(today));

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'Dates must be YYYY-MM-DD.' });
  }
  if (from > to) [from, to] = [to, from];

  const notes = [];
  if (from < floor) {
    notes.push(floorNote(floor));
    from = floor;
  }

  /* Which accounts the dashboard covers is a saved setting, not a query
     parameter — chosen once on FB Settings rather than re-picked on every
     visit. It is part of the cache key, so changing the selection shows the
     new answer instead of the previous one for the next ten minutes. */
  /* A viewer's scope is their own assignment, never the dashboard selection
     an admin saved — that list may well include accounts they cannot see. */
  const chosen = req.allowedAccounts || readDashboardAccounts();
  const scope = chosen.length ? chosen.join(',') : 'all';
  const key = `${from}|${to}|${param}|${scope}`;
  const cached = accountsSummary.get(key);
  if (cached && req.query.refresh !== '1' && Date.now() - cached.at < SUMMARY_TTL_MS) {
    return res.json({ ...cached.payload, cached: true, fetchedAt: new Date(cached.at).toISOString() });
  }

  let lastFinalDate = null;
  try {
    const { data } = await getV4Client().getStatisticsStatus();
    lastFinalDate = data?.lastFinalDate || null;
  } catch { /* only decides what gets cached */ }

  /* Tonic is fetched once for the whole range, not once per account: the join
     key is the adset ID, which belongs to no particular account, so the same
     day cache serves all of them. */
  const tonicFill = await ensureTonicRange(from, to, param, lastFinalDate);
  const byKey = new Map(sessionDays.range(from, to, param).map((r) => [String(r.key), r]));

  const all = await getFbClient().getAdAccounts();

  /* Choosing a few accounts is the difference between two Facebook calls and
     two per account, which on the development tier is seconds against
     minutes. */
  const accounts = chosen.length ? all.filter((a) => chosen.includes(a.id)) : all;

  if (chosen.length && !accounts.length) {
    return res.status(404).json({
      error: 'The ad accounts chosen for the dashboard are not reachable with this token.',
      hint: 'Choose them again on the FB Settings screen.',
      code: 'NO_FB_ACCOUNTS',
    });
  }
  if (!chosen.length && all.length > 3) {
    notes.push(
      `Showing all ${all.length} ad accounts, which needs two Facebook calls each. `
      + 'Choose the ones you actually watch on the FB Settings screen and this loads in seconds.'
    );
  }

  const rows = [];

  for (const acct of accounts) {
    /* Serial on purpose — see the note above. Promise.all here is what
       produced the #613 concurrency errors. */
    try {
      const insights = await getFbClient().getAdsetInsights({ since: from, until: to, accountId: acct.id });
      const info = await getFbClient().getAccountInfo(acct.id)
        .catch(() => ({ currency: acct.currency || 'USD' }));

      rows.push({
        accountId: acct.id,
        name: acct.name,
        currency: info.currency || acct.currency || 'USD',
        active: acct.active,
        businessId: acct.businessId,
        businessName: acct.businessName,
        truncated: insights.truncated,
        ...foldAccount(insights.rows, byKey),
      });
    } catch (err) {
      /* One unreachable account must not cost the other nine. The row carries
         the reason instead of a row of zeros, which would read as "spent
         nothing" rather than "could not be asked". */
      rows.push({
        accountId: acct.id,
        name: acct.name,
        currency: acct.currency || null,
        businessId: acct.businessId,
        businessName: acct.businessName,
        error: err.message,
      });
    }
  }

  rows.sort((a, b) => (b.spend || 0) - (a.spend || 0) || String(a.name).localeCompare(String(b.name)));

  /* Tonic reports revenue in USD. Subtracting spend booked in another currency
     from it gives a number that is not profit in either currency, so those
     accounts are listed but kept out of the total rather than quietly folded
     in at an implied rate of 1:1. */
  const comparable = rows.filter((r) => !r.error && r.currency === 'USD');
  const foreign = rows.filter((r) => !r.error && r.currency !== 'USD');
  const failed = rows.filter((r) => r.error);

  if (foreign.length) {
    notes.push(
      `${foreign.map((r) => r.name || r.accountId).join(', ')} ${foreign.length === 1 ? 'books' : 'book'} `
      + 'spend in a currency other than USD, while Tonic reports revenue in USD. '
      + 'Those rows are shown but left out of the total.'
    );
  }
  if (failed.length) {
    notes.push(`${failed.length} ad account${failed.length === 1 ? '' : 's'} could not be fetched; the reason is on the row.`);
  }
  if (lastFinalDate && to > lastFinalDate) {
    notes.push(`Tonic has finalised revenue through ${lastFinalDate}; anything after that is an estimate and can still change.`);
  }
  if (tonicFill.unreported.length) {
    notes.push(unreportedNote(tonicFill.unreported));
  }

  const payload = {
    rows,
    totals: totalsFrom(comparable),
    meta: {
      from, to, param, lastFinalDate,
      scope,
      dataStart: DATA_START_DATE,
      daysFetched: tonicFill.fetched,
      daysFromCache: tonicFill.cached,
    },
    notes,
  };

  accountsSummary.set(key, { at: Date.now(), payload });
  res.json({ ...payload, cached: false, fetchedAt: new Date().toISOString() });
}));

/**
 * One adset, one day, hour by hour.
 *
 * Both sides are asked for the same single day, but they count hours on
 * different clocks: Meta aggregates in the ad account's timezone, Tonic
 * timestamps on its own PST/PDT one. Meta's buckets are fixed, so Tonic's
 * sessions are converted into the account's timezone and bucketed there, and
 * the response names the timezone so the table can say which clock it is on.
 */
router.get('/adsets/:id/hours', requireCredentials, requireFbCredentials, asyncRoute(async (req, res) => {
  const stored = readFbSettings();
  const param = String(req.query.param || stored.joinParam).trim();
  const adsetId = String(req.params.id);
  const date = String(req.query.date || '');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Date must be YYYY-MM-DD.' });
  }

  const today = new Date();
  const floor = rangeFloor(today);
  if (date < floor) {
    return res.status(400).json({ error: floorNote(floor) });
  }
  if (date > iso(today)) {
    return res.status(400).json({ error: 'That day has not happened yet.' });
  }

  const accountId = accountFor(req, req.query.account);
  const notes = [];

  const account = await getFbClient().getAccountInfo(accountId)
    .catch(() => ({ currency: 'USD', timezone: null }));

  /* Without the account's timezone the two sides cannot be aligned honestly.
     Falling back to Tonic's clock keeps the page working and says so, rather
     than lining up hours that do not correspond. */
  const timeZone = account.timezone || TONIC_TZ;
  if (!account.timezone) {
    notes.push(
      'Facebook did not report this ad account\'s timezone, so the hours are shown on '
      + "Tonic's clock (US Pacific). If the ad account runs on another timezone, spend and "
      + 'revenue in a row may be an hour or more apart.'
    );
  }

  const [fbHours, tonicSide] = await Promise.all([
    getFbClient().getAdsetHourlyInsights({ adsetId, date }).catch((err) => {
      notes.push(`Facebook returned no hourly data: ${err.message}`);
      return [];
    }),
    fetchTonicHours({
      client: getV4Client(),
      date,
      param,
      adsetId,
      timeZone,
      pageSize: PAGE_SIZE,
      maxPages: MAX_PAGES,
    }).catch((err) => {
      if (!/later than the maximum date/i.test(err?.message || '')) throw err;
      notes.push(unreportedNote([date]));
      return { hours: new Map(), sessions: 0, matched: 0, outsideDay: 0, truncated: false };
    }),
  ]);

  const fbByHour = new Map(fbHours.map((h) => [h.hour, h]));

  /* All twenty-four hours, always. A gap in the middle of a day is a fact
     about the day, and a table that silently skips to the next hour with
     spend hides it. */
  const rows = Array.from({ length: 24 }, (_, hour) => {
    const fb = fbByHour.get(hour) || { spend: 0, impressions: 0, clicks: 0, leads: 0 };
    const t = tonicSide.hours.get(hour) || { sessions: 0, conversions: 0, revenue: 0 };
    const revenue = Number(t.revenue) || 0;
    const profit = revenue - fb.spend;

    return {
      hour,
      label: `${String(hour).padStart(2, '0')}:00`,
      spend: round(fb.spend),
      revenue: round(revenue),
      profit: round(profit),
      roi: fb.spend > 0 ? round((profit / fb.spend) * 100, 1) : null,
      cpl: t.conversions > 0 ? round(fb.spend / t.conversions, 3) : null,
      rpc: t.conversions > 0 ? round(revenue / t.conversions, 3) : null,
      leads: fb.leads,
      conversions: t.conversions,
      sessions: t.sessions,
      impressions: fb.impressions,
      clicks: fb.clicks,
    };
  });

  const sum = (f) => rows.reduce((n, r) => n + (Number(r[f]) || 0), 0);
  const spend = sum('spend');
  const revenue = sum('revenue');
  const conversions = sum('conversions');

  if (tonicSide.outsideDay > 0) {
    notes.push(
      `${tonicSide.outsideDay} session${tonicSide.outsideDay === 1 ? '' : 's'} fell outside `
      + `${date} once converted to ${timeZone}, so ${tonicSide.outsideDay === 1 ? 'it belongs' : 'they belong'} `
      + 'to the neighbouring day and is not counted here.'
    );
  }
  if (tonicSide.truncated) {
    notes.push('This day had more sessions than one fetch covers; revenue may be low.');
  }
  notes.push('Hourly revenue is Tonic\'s running estimate and moves until the day is finalised.');

  res.json({
    date,
    timeZone,
    rows,
    totals: {
      spend: round(spend),
      revenue: round(revenue),
      profit: round(revenue - spend),
      roi: spend > 0 ? round(((revenue - spend) / spend) * 100, 1) : null,
      cpl: conversions > 0 ? round(spend / conversions, 3) : null,
      rpc: conversions > 0 ? round(revenue / conversions, 3) : null,
      leads: sum('leads'),
      conversions,
      sessions: sum('sessions'),
      impressions: sum('impressions'),
      clicks: sum('clicks'),
    },
    meta: { adsetId, param, accountId, currency: account.currency || 'USD' },
    notes,
  });
}));

/**
 * The ad accounts the caller may actually look at.
 *
 * Final Data's own picker used to read /fb-settings/accounts, which is closed
 * to viewers — so a viewer saw an empty picker and a message blaming the
 * Facebook token for something that was really this app refusing the route.
 * This lives under /final-data because that is the one place a viewer can
 * reach, and it returns their assignment rather than everything the token
 * can see.
 */
router.get('/ad-accounts', requireCredentials, requireFbCredentials, asyncRoute(async (req, res) => {
  const all = await getFbClient().getAdAccounts();
  const allowed = req.allowedAccounts;

  const accounts = allowed ? all.filter((a) => allowed.includes(a.id)) : all;
  const stored = readFbSettings();

  /* Someone assigned several accounts wants all of them: looking at one at a
     time is the special case, not the default. With a single account there is
     nothing to combine, so that account is the selection. The remembered
     account belongs to the admin and means nothing here. */
  const selected = allowed
    ? (accounts.length > 1 ? 'all' : accounts[0]?.id || null)
    : stored.adAccountId;

  res.json({
    accounts,
    selected,
    /* Says which case an empty list is, so the screen can stop blaming the
       token for an assignment that was never made. */
    restricted: Boolean(allowed),
  });
}));

export default router;
