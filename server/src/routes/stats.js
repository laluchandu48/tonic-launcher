import { Router } from 'express';
import { asyncRoute, requireCredentials } from '../lib/http.js';
import { getV4Client } from '../lib/credentials.js';
import { revenueMonths } from '../db/index.js';

const router = Router();
router.use(requireCredentials);

/**
 * On v3 this file joined two reports by hand — clicks and revenue from one
 * endpoint, view counts from another that only went back 8 days — and derived
 * VTC, RPC and RPMV itself.
 *
 * v4 returns all six metrics natively, so this is now mostly parameter
 * marshalling. The 8-day view limit is gone with it.
 */

const TONIC_TZ = 'America/Los_Angeles';
const ALL_STATES = 'pending,active,stopped';
const MAX_DAYS_DAY_GROUPING = 31;
const MAX_DAYS_MONTH_GROUPING = 186;

function tonicToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TONIC_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function shiftDate(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const daysBetween = (from, to) =>
  Math.round((new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / 86_400_000) + 1;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** v4 gives vtc/rpc/rpmv per row; totals still have to be recomputed, not summed. */
function withDerived({ views, clicks, revenue }) {
  return {
    views, clicks, revenue: Number(revenue.toFixed(4)),
    vtc: views > 0 ? Number(((clicks / views) * 100).toFixed(2)) : 0,
    rpc: clicks > 0 ? Number((revenue / clicks).toFixed(4)) : 0,
    rpmv: views > 0 ? Number(((revenue / views) * 1000).toFixed(4)) : 0,
  };
}

const statsOf = (s) => ({
  views: num(s?.views), clicks: num(s?.clicks), revenue: num(s?.revenue),
  vtc: num(s?.vtc), rpc: num(s?.rpc), rpmv: num(s?.rpmv),
});

router.get('/today', (req, res) => res.json({ today: tonicToday() }));

/**
 * Grouped by campaign, day or month. Campaign grouping comes from the campaign
 * list with stats attached; day and month from the performance endpoint.
 */
router.get('/', asyncRoute(async (req, res) => {
  const client = getV4Client();
  const today = tonicToday();
  const to = req.query.to || today;
  const from = req.query.from || to;
  const group = ['campaign', 'day', 'month'].includes(req.query.group) ? req.query.group : 'campaign';

  if (from > to) return res.status(400).json({ error: 'The start date is after the end date.' });

  const span = daysBetween(from, to);
  const cap = group === 'month' ? MAX_DAYS_MONTH_GROUPING : MAX_DAYS_DAY_GROUPING;
  if (span > cap) {
    return res.status(400).json({
      error: `Tonic allows at most ${cap} days for ${group === 'month' ? 'month' : 'day'} grouping. That range is ${span} days.`,
    });
  }

  const state = req.query.state || ALL_STATES;
  let rows = [];

  if (group === 'campaign') {
    const { data } = await client.getCampaigns({ state, stats: true, from, to, limit: 100 });
    rows = (Array.isArray(data) ? data : []).map((c) => ({
      key: String(c.id),
      campaignId: String(c.id),
      campaignName: c.name,
      date: null,
      ...statsOf(c.stats),
    }));
  } else {
    const { data } = await client.getCampaignPerformance({ state, grouping: group, from, to, limit: 100 });
    rows = (Array.isArray(data) ? data : []).map((p) => ({
      key: group === 'month' ? (p.month || String(p.date).slice(0, 7)) : p.date,
      date: p.date ?? null,
      campaignCount: p.campaignCount ?? null,
      ...statsOf(p.stats),
    }));
  }

  rows.sort((a, b) => (group === 'campaign'
    ? b.revenue - a.revenue || b.clicks - a.clicks
    : String(b.key).localeCompare(String(a.key))));

  const sum = (f) => rows.reduce((acc, r) => acc + (r[f] || 0), 0);
  const totals = withDerived({ views: sum('views'), clicks: sum('clicks'), revenue: sum('revenue') });
  const divisor = rows.length || 1;

  res.json({
    from, to, group, today, rows, totals,
    averages: {
      views: Number((totals.views / divisor).toFixed(2)),
      clicks: Number((totals.clicks / divisor).toFixed(2)),
      revenue: Number((totals.revenue / divisor).toFixed(4)),
    },
    notes: [],   // the v3 8-day view-count caveat no longer applies
  });
}));

/** Dashboard headline numbers. */
router.get('/summary', asyncRoute(async (req, res) => {
  const client = getV4Client();
  const today = tonicToday();
  const thisMonth = today.slice(0, 7);

  const totalsFor = async (from, to) => {
    const { data } = await client.getCampaigns({ state: ALL_STATES, stats: true, from, to, limit: 100 });
    const rows = Array.isArray(data) ? data : [];
    return rows.reduce((acc, c) => ({
      clicks: acc.clicks + num(c.stats?.clicks),
      revenue: acc.revenue + num(c.stats?.revenue),
      views: acc.views + num(c.stats?.views),
    }), { clicks: 0, revenue: 0, views: 0 });
  };

  const [last30, todayTotals] = await Promise.all([
    totalsFor(shiftDate(today, -29), today).catch(() => ({ clicks: 0, revenue: 0, views: 0 })),
    totalsFor(today, today).catch(() => ({ clicks: 0, revenue: 0, views: 0 })),
  ]);

  // Keep the current month's cache warm; it is one extra call.
  try {
    const current = await totalsFor(`${thisMonth}-01`, today);
    revenueMonths.upsert({ month: thisMonth, revenue: current.revenue, clicks: current.clicks, complete: false });
  } catch { /* only makes the all-time figure staler, never wrong */ }

  const cached = revenueMonths.totals();
  const stored = revenueMonths.all();

  res.json({
    today,
    last30Revenue: Number(last30.revenue.toFixed(4)),
    todayConversions: todayTotals.clicks,
    todayRevenue: Number(todayTotals.revenue.toFixed(4)),
    allTime: {
      revenue: cached.revenue, clicks: cached.clicks, monthsCached: cached.months,
      earliest: stored[0]?.month ?? null,
      stale: cached.months <= 1,
    },
  });
}));

/**
 * All-time revenue, month by month. v4 allows 186 days per call with month
 * grouping, so this is roughly six calls per three years instead of one per
 * month — but the cache is kept because it still is not free.
 */
router.post('/alltime/refresh', asyncRoute(async (req, res) => {
  const client = getV4Client();
  const today = tonicToday();
  const thisMonth = today.slice(0, 7);
  const earliest = req.body?.since || '2023-01-01';

  let cursor = earliest;
  let fetched = 0;
  const failures = [];

  while (cursor <= today) {
    const windowEnd = [shiftDate(cursor, MAX_DAYS_MONTH_GROUPING - 1), today]
      .sort()[0];
    try {
      const { data } = await client.getCampaignPerformance({
        state: ALL_STATES, grouping: 'month', from: cursor, to: windowEnd, limit: 100,
      });
      for (const p of Array.isArray(data) ? data : []) {
        const month = p.month || String(p.date || '').slice(0, 7);
        if (!month) continue;
        revenueMonths.upsert({
          month,
          revenue: num(p.stats?.revenue),
          clicks: num(p.stats?.clicks),
          complete: month !== thisMonth,
        });
        fetched += 1;
      }
    } catch (err) {
      failures.push({ from: cursor, to: windowEnd, error: err.message });
    }
    cursor = shiftDate(windowEnd, 1);
  }

  const cached = revenueMonths.totals();
  res.json({
    fetched, skipped: 0, failures,
    allTime: { revenue: cached.revenue, clicks: cached.clicks, monthsCached: cached.months },
  });
}));

/** Revenue by offer, for the dashboard's top-offers chart. */
router.get('/offers', asyncRoute(async (req, res) => {
  const today = tonicToday();
  const to = req.query.to || today;
  const from = req.query.from || shiftDate(to, -6);
  const limit = Math.min(Number(req.query.limit) || 5, 12);

  const { data } = await getV4Client().getCampaigns({
    state: ALL_STATES, stats: true, from, to, limit: 100,
  });

  // v4 carries the offer on the campaign, so the campaign-to-offer lookup that
  // v3 needed is gone.
  const byOffer = new Map();
  for (const c of Array.isArray(data) ? data : []) {
    const offer = c.offer?.name || 'Unknown offer';
    const entry = byOffer.get(offer) || { offer, revenue: 0, clicks: 0 };
    entry.revenue += num(c.stats?.revenue);
    entry.clicks += num(c.stats?.clicks);
    byOffer.set(offer, entry);
  }

  const all = [...byOffer.values()].sort((a, b) => b.revenue - a.revenue);
  const top = all.slice(0, limit);
  const rest = all.slice(limit);
  if (rest.length) {
    top.push({
      offer: `Other (${rest.length})`,
      revenue: rest.reduce((a, r) => a + r.revenue, 0),
      clicks: rest.reduce((a, r) => a + r.clicks, 0),
    });
  }

  const total = all.reduce((a, r) => a + r.revenue, 0);
  res.json({
    from, to, total: Number(total.toFixed(4)),
    offers: top.map((o) => ({
      ...o,
      revenue: Number(o.revenue.toFixed(4)),
      share: total > 0 ? Number(((o.revenue / total) * 100).toFixed(1)) : 0,
    })),
  });
}));

/** lastFinalDate — revenue after this date is still an estimate. */
router.get('/last-final', asyncRoute(async (req, res) => {
  const { data } = await getV4Client().getStatisticsStatus();
  res.json({
    lastFinal: data?.lastFinalDate ?? null,
    lastClosedMonth: data?.lastClosedMonth ?? null,
    finalizedOn: data?.finalizedOn ?? null,
  });
}));

export default router;
