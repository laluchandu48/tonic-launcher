import { Router } from 'express';
import { asyncRoute, requireCredentials } from '../lib/http.js';
import { getV4Client } from '../lib/credentials.js';

const router = Router();
router.use(requireCredentials);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** Shared paging + sorting, clamped so a bad query string cannot ask for everything. */
function paging(q, { limitKey = 'limit', offsetKey = 'offset' } = {}) {
  const limit = Math.min(Math.max(Number(q[limitKey]) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(Number(q[offsetKey]) || 0, 0);
  return { limit, offset };
}

/** v4 returns { data, pagination } — pass both through unchanged. */
const envelope = (result) => ({
  rows: Array.isArray(result.data) ? result.data : result.data ? [result.data] : [],
  pagination: result.pagination,
  warnings: result.warnings,
});

// ─── Ad IDs ──────────────────────────────────────────────────────────────────

router.get('/ad-ids', asyncRoute(async (req, res) => {
  const q = req.query;
  const result = await getV4Client().getAdIds({
    ...paging(q),
    status: q.status,                       // allowed | declined
    campaignIds: q.campaignIds,
    campaignName: q.campaignName,
    networkIds: q.networkIds,
    adIds: q.adIds,
    networks: q.networks,
    hasReviewRequest: q.hasReviewRequest,
    reviewRequestStatus: q.reviewRequestStatus,
    hasComplianceStatusChangeDate: q.hasComplianceStatusChangeDate,
    // The dashboard's "immediate action required" quick filter is just
    // declined ads that are still earning — i.e. revenue above zero.
    revenueFrom: q.revenueFrom,
    revenueTo: q.revenueTo,
    orderField: q.orderField,
    orderOrientation: q.orderOrientation,
  });
  res.json(envelope(result));
}));

router.get('/ad-ids/change-log', asyncRoute(async (req, res) => {
  const q = req.query;
  const result = await getV4Client().getAdIdChangeLog({
    ...paging(q),
    adId: q.adId,
    campaignId: q.campaignId,
    campaignName: q.campaignName,
    // Tonic caps this range at 3 days; the UI defaults to exactly that.
    from: q.from,
    to: q.to,
    orderField: q.orderField,
    orderOrientation: q.orderOrientation,
  });
  res.json(envelope(result));
}));

router.get('/ad-ids/:id', asyncRoute(async (req, res) => {
  const result = await getV4Client().getAdIdDetail(req.params.id);
  res.json({ adId: result.data, warnings: result.warnings });
}));

/**
 * Ask Tonic to reconsider a declined ad. The message is what a human reads,
 * so the length bounds are enforced here rather than letting the API reject it.
 */
router.post('/ad-ids/review-request', asyncRoute(async (req, res) => {
  const { campaignId, adId, message } = req.body || {};
  const text = String(message || '').trim();
  const fields = {};

  if (!campaignId) fields.campaignId = 'Required.';
  if (!adId) fields.adId = 'Required.';
  if (text.length < 10) fields.message = 'Explain the request in at least 10 characters.';
  else if (text.length > 500) fields.message = 'Keep the message to 500 characters or fewer.';

  if (Object.keys(fields).length) {
    return res.status(400).json({ error: 'Please correct the highlighted fields.', fields });
  }

  const result = await getV4Client().sendReviewRequest({ campaignId, adId, message: text });
  res.status(201).json({ reviewRequest: result.data });
}));

// ─── Site IDs ────────────────────────────────────────────────────────────────

/**
 * Two different lists: `enforced` is what Tonic blocks network-wide, `detected`
 * is what has been seen in this account's own traffic. The UI shows detected
 * first because that is the one you can act on.
 */
router.get('/site-ids', asyncRoute(async (req, res) => {
  const q = req.query;
  const client = getV4Client();
  const scope = q.scope === 'enforced' ? 'enforced' : 'detected';

  const result = scope === 'enforced'
    ? await client.getSiteIds({ ...paging(q), network: q.network })
    : await client.getDetectedSiteIds({
        ...paging(q),
        network: q.network,
        siteId: q.siteId,
        site: q.site,
        orderField: q.orderField,
        orderOrientation: q.orderOrientation,
      });

  res.json({ scope, ...envelope(result) });
}));

// ─── Traffic check ───────────────────────────────────────────────────────────

/**
 * Network clicks vs the redirects Tonic actually recorded. A large gap means
 * clicks are being paid for that never arrive, so the deviation is computed
 * here rather than left for the reader to work out.
 */
router.get('/traffic-check', asyncRoute(async (req, res) => {
  const result = await getV4Client().getTrafficCheck({
    ...paging(req.query),
    network: req.query.network,
  });

  const rows = (Array.isArray(result.data) ? result.data : result.data ? [result.data] : [])
    .map((row) => {
      const clicks = Number(row.networkClickCount) || 0;
      const redirects = Number(row.redirectCount) || 0;
      return {
        ...row,
        networkClickCount: clicks,
        redirectCount: redirects,
        // Negative means fewer redirects than clicks — the direction that costs money.
        deviation: clicks > 0 ? Number((((redirects - clicks) / clicks) * 100).toFixed(1)) : null,
      };
    });

  res.json({ rows, pagination: result.pagination, warnings: result.warnings });
}));

// ─── Parameter compliance (the "Missing Parameters" tab) ─────────────────────

router.get('/parameters', asyncRoute(async (req, res) => {
  const q = req.query;
  const result = await getV4Client().getParameterCompliance({
    ...paging(q),
    campaignStatus: q.campaignStatus,
    complianceStatus: q.complianceStatus,   // warning | critical
    campaignName: q.campaignName,
    campaignId: q.campaignId,
    sort: q.sort,
    order: q.order,
  });
  res.json(envelope(result));
}));

export default router;
