/**
 * Keyword performance — Tonic's Keywords tab, served from /statistics/keywords.
 *
 * One row per keyword, carrying the campaigns it ran in, the countries and
 * offers it touched, and its clicks, revenue and RPC. The campaigns come back
 * nested with their own stats, so expanding a row on the client costs nothing:
 * the detail is already in the payload that drew the row.
 *
 * Two limits shape this endpoint:
 *
 *   - v4 refuses a range longer than 30 days. Rather than returning an error
 *     for a range the person can see in the picker, the range is clamped and
 *     the response says so.
 *
 *   - Ordering and paging are the API's, not ours. Sorting a page of 25 rows
 *     in the browser would sort that page only, which reads as a broken sort
 *     the moment there is a second page.
 */
import { Router } from 'express';
import { asyncRoute, requireCredentials } from '../lib/http.js';
import { getV4Client } from '../lib/credentials.js';

const router = Router();

/** v4's cap on this endpoint. */
const MAX_RANGE_DAYS = 30;
const DAY = 86_400_000;

const iso = (d) => d.toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);
const round = (n, places = 2) => {
  const f = 10 ** places;
  return Math.round((Number(n) || 0) * f) / f;
};

/** The only fields v4 will order by. Anything else is ignored rather than passed on. */
const ORDER_FIELDS = new Set(['keyword', 'clicks', 'rpc', 'revenue', 'revenueUsd']);

/**
 * Work out the range to ask for, clamping it to what v4 accepts.
 *
 * Exported for tests: this is the part with arithmetic in it, and an
 * off-by-one here is a silently shorter report rather than a visible error.
 */
export function resolveRange({ from, to, today }) {
  // Both are `let`: a range entered backwards is swapped below rather than
  // refused, and swapping needs to write to each of them.
  let end = isDate(to) ? to : today;
  let start = isDate(from) ? from : end;
  const notes = [];

  if (start > end) [start, end] = [end, start];

  const span = Math.round(
    (new Date(`${end}T12:00:00Z`) - new Date(`${start}T12:00:00Z`)) / DAY
  ) + 1;

  if (span > MAX_RANGE_DAYS) {
    const clamped = iso(new Date(new Date(`${end}T12:00:00Z`).getTime() - (MAX_RANGE_DAYS - 1) * DAY));
    notes.push(
      `Tonic allows at most ${MAX_RANGE_DAYS} days of keyword data in one request, `
      + `so this starts at ${clamped} rather than ${start}.`
    );
    start = clamped;
  }

  return { from: start, to: end, days: Math.min(span, MAX_RANGE_DAYS), notes };
}

/** Turn one v4 keyword row into the shape the table renders. */
export function presentKeyword(row) {
  const campaigns = (Array.isArray(row?.campaigns) ? row.campaigns : []).map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status || null,
    type: c.type || null,
    offer: c.offer?.name || null,
    vertical: c.offer?.vertical?.name || null,
    country: c.country?.code || null,
    countryName: c.country?.name || null,
    keywordAmount: c.keywordAmount ?? null,
    clicks: num(c.stats?.clicks),
    views: num(c.stats?.views),
    revenue: round(num(c.stats?.revenue)),
    rpc: c.stats?.rpc == null ? null : round(num(c.stats.rpc), 3),
  }));

  const countries = (Array.isArray(row?.countries) ? row.countries : [])
    .map((c) => ({ code: c.code, name: c.name }))
    .filter((c) => c.code);

  const offers = (Array.isArray(row?.offers) ? row.offers : []).map((o) => ({
    id: o.id,
    name: o.name,
    vertical: o.vertical?.name || null,
  }));

  return {
    keyword: row?.keyword ?? '',
    clicks: num(row?.clicks),
    revenue: round(num(row?.revenue)),
    rpc: row?.rpc == null ? null : round(num(row.rpc), 3),
    campaigns,
    countries,
    offers,
  };
}

/**
 * Totals for the page on screen.
 *
 * RPC is computed from the totals rather than averaged across keywords — the
 * mean of per-keyword RPCs weights a keyword with one click the same as one
 * with a thousand, and reports a figure nobody earned.
 */
export function totalsFrom(rows) {
  const clicks = rows.reduce((n, r) => n + num(r.clicks), 0);
  const revenue = rows.reduce((n, r) => n + num(r.revenue), 0);
  return {
    keywords: rows.length,
    clicks,
    revenue: round(revenue),
    rpc: clicks > 0 ? round(revenue / clicks, 3) : null,
  };
}

/** Only pass a filter on when it has a value; v4 treats an empty one as a filter. */
const some = (v) => {
  const s = String(v ?? '').trim();
  return s ? s : undefined;
};

router.get('/', requireCredentials, asyncRoute(async (req, res) => {
  const today = iso(new Date());
  const { from, to, days, notes } = resolveRange({
    from: req.query.from, to: req.query.to, today,
  });

  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const orderField = ORDER_FIELDS.has(String(req.query.orderField)) ? String(req.query.orderField) : 'revenue';
  const orderOrientation = String(req.query.orderOrientation) === 'asc' ? 'asc' : 'desc';

  /* campaignName is rejected by v4 below three characters, so a shorter one is
     dropped here rather than turned into a 400 the person cannot act on. */
  const campaignName = some(req.query.campaignName);

  const query = {
    from,
    to,
    limit,
    offset,
    orderField,
    orderOrientation,
    keywordPart: some(req.query.search),
    campaignName: campaignName && campaignName.length >= 3 ? campaignName : undefined,
    campaignIds: some(req.query.campaignIds),
    countryCodes: some(req.query.countryCodes),
    offerIds: some(req.query.offerIds),
    campaignTypes: some(req.query.campaignTypes),
  };

  if (campaignName && campaignName.length < 3) {
    notes.push('A campaign name filter needs at least three characters, so it was not applied.');
  }

  const { data, pagination, warnings } = await getV4Client().getKeywordStats(query);
  const rows = (Array.isArray(data) ? data : []).map(presentKeyword);

  for (const w of warnings || []) notes.push(String(w));

  res.json({
    rows,
    totals: totalsFrom(rows),
    pagination,
    meta: { from, to, days, limit, offset, orderField, orderOrientation },
    notes,
  });
}));

export default router;
