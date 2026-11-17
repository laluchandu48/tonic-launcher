/**
 * Country — Tonic revenue and Facebook spend, per Tonic campaign per country.
 *
 * Both sides can be split by country, which is what makes this screen
 * possible at all:
 *
 *   - Tonic's session report carries a `country` column, so the same call
 *     Final Data already makes every day gives revenue per country. It is
 *     cached at that grain beside the per-adset cache, from the same
 *     response, so the two can never disagree.
 *
 *   - Meta returns insights broken down by country, which is the only way to
 *     get spend against a country: the unsplit figure cannot be divided after
 *     the fact.
 *
 * The join is the same one the rest of the app rests on — the adset id in the
 * tracking link — applied per country. Tonic names the campaign; Facebook pays
 * for it, so the row's spend has to be attributed from the adset to whichever
 * Tonic campaign that adset fed. Usually one, and then it is exact; the
 * awkward case is handled below and reported rather than hidden.
 */
import { Router } from 'express';
import { asyncRoute, requireCredentials } from '../lib/http.js';
import { getV4Client } from '../lib/credentials.js';
import { getFbClient, readFbSettings, requireFbCredentials } from '../lib/fbCredentials.js';
import { normaliseAdAccountId } from '../lib/facebook.js';
import { sessionDays } from '../db/index.js';
import { ensureTonicRange, rangeFloor, floorNote, round } from './finalData.js';

const router = Router();

const DAY = 86_400_000;
const iso = (d) => d.toISOString().slice(0, 10);
const maxDate = (a, b) => (a > b ? a : b);

/** Tonic reports a session with no country as this. */
const UNKNOWN = '??';

/**
 * Split one adset's spend in one country across the Tonic campaigns it fed.
 *
 * Almost always there is exactly one, and this returns the whole amount
 * against it. When an adset's traffic landed on several Tonic campaigns there
 * is no fact of the matter about which spend bought which session, so it is
 * divided by revenue — the only signal present — falling back to clicks and
 * then to an even split. The response says when this happened, because a
 * divided number should not be read as a measured one.
 */
export function splitSpend(amount, campaigns) {
  if (campaigns.length === 0) return [];
  if (campaigns.length === 1) return [{ ...campaigns[0], share: 1 }];

  for (const field of ['revenue', 'clicks', 'sessions']) {
    const total = campaigns.reduce((n, c) => n + (Number(c[field]) || 0), 0);
    if (total > 0) {
      return campaigns.map((c) => ({ ...c, share: (Number(c[field]) || 0) / total }));
    }
  }
  return campaigns.map((c) => ({ ...c, share: 1 / campaigns.length }));
}

/** Everything derived from the two sides, in one place so the row and the total agree. */
export function derive(row) {
  const profit = row.revenue - row.spend;
  return {
    ...row,
    spend: round(row.spend),
    revenue: round(row.revenue),
    profit: round(profit),
    roi: row.spend > 0 ? round((profit / row.spend) * 100, 1) : null,
    cpl: row.conversions > 0 ? round(row.spend / row.conversions, 3) : null,
    rpc: row.conversions > 0 ? round(row.revenue / row.conversions, 3) : null,
  };
}

/**
 * Fold both sides into one row per Tonic campaign and country.
 *
 * Exported and free of network calls so it can be tested against fixtures:
 * this is the part with the arithmetic in it.
 */
export function foldCountries(fbRows, tonicRows) {
  /* Tonic first, because it is what names a campaign. Keyed by adset and
     country so Facebook's spend can find it. */
  const tonicByAdset = new Map();
  for (const t of tonicRows) {
    const k = `${t.key}\u0000${t.country}`;
    const list = tonicByAdset.get(k) || [];
    list.push(t);
    tonicByAdset.set(k, list);
  }

  const out = new Map();
  const touch = (campaignId, campaignName, country) => {
    const k = `${campaignId}\u0000${country}`;
    const row = out.get(k) || {
      campaignId: campaignId || null,
      campaignName: campaignName || null,
      country,
      spend: 0,
      revenue: 0,
      conversions: 0,
      sessions: 0,
      leads: 0,
      impressions: 0,
      clicks: 0,
      adsets: new Set(),
      matched: false,
      estimated: false,
    };
    if (!row.campaignName && campaignName) row.campaignName = campaignName;
    out.set(k, row);
    return row;
  };

  for (const t of tonicRows) {
    const row = touch(t.campaignId, t.campaignName, t.country);
    row.revenue += Number(t.revenue) || 0;
    row.conversions += Number(t.clicks) || 0;
    row.sessions += Number(t.sessions) || 0;
  }

  let splits = 0;
  let unattributed = 0;

  for (const f of fbRows) {
    const country = String(f.country || '').toUpperCase() || UNKNOWN;
    const campaigns = tonicByAdset.get(`${f.adsetId}\u0000${country}`) || [];

    if (campaigns.length === 0) {
      /* Spend in a country that returned no Tonic session. Kept, under a row
         with no campaign name: dropping it would make the spend total on this
         screen disagree with Final Data for the same range. */
      unattributed += Number(f.spend) || 0;
      const row = touch('', null, country);
      row.spend += Number(f.spend) || 0;
      row.leads += Number(f.leads) || 0;
      row.impressions += Number(f.impressions) || 0;
      row.clicks += Number(f.clicks) || 0;
      row.adsets.add(f.adsetId);
      continue;
    }

    if (campaigns.length > 1) splits += 1;

    for (const part of splitSpend(Number(f.spend) || 0, campaigns)) {
      const row = touch(part.campaignId, part.campaignName, country);
      row.spend += (Number(f.spend) || 0) * part.share;
      row.leads += (Number(f.leads) || 0) * part.share;
      row.impressions += (Number(f.impressions) || 0) * part.share;
      row.clicks += (Number(f.clicks) || 0) * part.share;
      row.adsets.add(f.adsetId);
      row.matched = true;
      if (campaigns.length > 1) row.estimated = true;
    }
  }

  const rows = [...out.values()]
    .map((r) => derive({
      ...r,
      leads: Math.round(r.leads),
      impressions: Math.round(r.impressions),
      clicks: Math.round(r.clicks),
      adsets: r.adsets.size,
    }))
    .sort((a, b) => b.spend - a.spend || b.revenue - a.revenue);

  return { rows, splits, unattributed: round(unattributed) };
}

/**
 * One row per campaign, with its countries under it.
 *
 * The campaign row is the whole campaign — every country it ran in — because
 * that is the number someone opens this screen to see. Its ratios are worked
 * out from the summed spend and revenue, never averaged from the country
 * rows: a campaign with £900 in one GEO and £1 in another is not the mean of
 * their two ROIs.
 */
export function groupByCampaign(rows) {
  const out = new Map();

  for (const r of rows) {
    const id = r.campaignId || '';
    const g = out.get(id) || {
      campaignId: r.campaignId || null,
      campaignName: r.campaignName || null,
      spend: 0, revenue: 0, conversions: 0, sessions: 0,
      leads: 0, impressions: 0, clicks: 0,
      estimated: false,
      countries: [],
    };
    g.spend += r.spend;
    g.revenue += r.revenue;
    g.conversions += r.conversions;
    g.sessions += r.sessions;
    g.leads += r.leads;
    g.impressions += r.impressions;
    g.clicks += r.clicks;
    g.estimated = g.estimated || Boolean(r.estimated);
    if (!g.campaignName && r.campaignName) g.campaignName = r.campaignName;
    g.countries.push(r);
    out.set(id, g);
  }

  return [...out.values()]
    .map((g) => ({
      ...derive(g),
      countries: [...g.countries].sort((a, b) => b.spend - a.spend || b.revenue - a.revenue),
    }))
    .sort((a, b) => b.spend - a.spend || b.revenue - a.revenue);
}

/** One row covering everything on screen, from the sums rather than the rows' own ratios. */
export function totalsOf(rows) {
  const sum = (f) => rows.reduce((n, r) => n + (Number(r[f]) || 0), 0);
  return {
    ...derive({
      spend: sum('spend'),
      revenue: sum('revenue'),
      conversions: sum('conversions'),
    }),
    leads: sum('leads'),
    impressions: sum('impressions'),
    clicks: sum('clicks'),
    sessions: sum('sessions'),
    countries: new Set(rows.map((r) => r.country)).size,
    campaigns: new Set(rows.map((r) => r.campaignId).filter(Boolean)).size,
  };
}

router.get('/', requireCredentials, requireFbCredentials, asyncRoute(async (req, res) => {
  const stored = readFbSettings();
  const param = String(req.query.param || stored.joinParam).trim();

  let accountId = normaliseAdAccountId(req.query.account) || stored.adAccountId;
  if (!accountId) {
    const accounts = await getFbClient().getAdAccounts();
    if (!accounts.length) {
      return res.status(428).json({
        error: 'This access token cannot see any ad accounts.',
        code: 'NO_FB_ACCOUNTS',
      });
    }
    accountId = accounts[0].id;
  }

  const today = new Date();
  const floor = rangeFloor(today);
  let from = String(req.query.from || maxDate(iso(new Date(today.getTime() - 6 * DAY)), floor));
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

  let lastFinalDate = null;
  try {
    const { data } = await getV4Client().getStatisticsStatus();
    lastFinalDate = data?.lastFinalDate || null;
  } catch {
    // Only decides what gets cached.
  }

  const [insights, fill] = await Promise.all([
    getFbClient().getAdsetCountryInsights({ since: from, until: to, accountId }),
    /* country: true — a day cached before this screen existed holds no
       country rows, and reporting it as empty would be a lie. */
    ensureTonicRange(from, to, param, lastFinalDate, { country: true }),
  ]);

  const account = await getFbClient().getAccountInfo(accountId)
    .catch(() => ({ id: accountId, name: accountId, currency: 'USD' }));

  const tonic = sessionDays.countryRange(from, to, param);
  const { rows: byCountry, splits, unattributed } = foldCountries(insights.rows, tonic);
  const rows = groupByCampaign(byCountry);
  /* From the country rows, so the total cannot drift from what the campaign
     rows add up to even if the grouping above changes. */
  const totals = totalsOf(byCountry);

  if (fill.unreported.length) {
    notes.push(
      `Tonic cannot report ${fill.unreported.length === 1 ? 'the day' : 'the days'} `
      + `${fill.unreported.join(', ')} yet, so ${fill.unreported.length === 1 ? 'it counts' : 'they count'} as zero revenue.`
    );
  }
  if (lastFinalDate && to > lastFinalDate) {
    notes.push(`Tonic has finalised revenue up to ${lastFinalDate}. Later days are estimates and will still move.`);
  }
  if (insights.truncated) {
    notes.push('Facebook returned more rows than this fetches; the spend side is incomplete.');
  }
  if (fill.truncatedDays.length) {
    notes.push(`Tonic's report hit its page limit on ${fill.truncatedDays.join(', ')}, so revenue on those days is low.`);
  }
  if (splits > 0) {
    notes.push(
      `${splits} adset${splits === 1 ? '' : 's'} sent traffic to more than one Tonic campaign in the same country. `
      + 'Their spend is divided between those campaigns in proportion to revenue — an estimate, not a measurement.'
    );
  }
  if (unattributed > 0) {
    notes.push(
      `${unattributed.toFixed(2)} of spend reached countries with no Tonic session against them. `
      + 'It is kept under a row with no campaign, so the total still matches Final Data.'
    );
  }
  if (byCountry.some((r) => r.country === UNKNOWN)) {
    notes.push('Sessions Tonic reported without a country are grouped under “??”.');
  }

  res.json({
    rows,
    totals,
    notes,
    meta: {
      from,
      to,
      param,
      accountId,
      accountName: account.name || accountId,
      currency: account.currency || 'USD',
      lastFinalDate,
      daysFetched: fill.fetched,
      daysFromCache: fill.cached,
      campaigns: rows.length,
      countryRows: byCountry.length,
    },
  });
}));

export default router;
