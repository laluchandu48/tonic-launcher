import { Router } from 'express';
import { asyncRoute, requireCredentials } from '../lib/http.js';
import { getV4Client } from '../lib/credentials.js';
import { campaigns, articleRequests } from '../db/index.js';

const router = Router();
router.use(requireCredentials);

const KEYWORD_MIN = 3;
const KEYWORD_MAX = 10;

/**
 * v4 names the callback events in camelCase and exposes them as one object on
 * the campaign, rather than v3's separate get/set/delete per event. The order
 * here is the order the Tonic dashboard shows.
 */
const CALLBACK_KEYS = [
  'redirect', 'view', 'viewRt', 'click',
  'preEstimatedRevenue', 'estimatedRevenue', 'estimatedRevenue5h',
];

const emptyStats = { views: 0, clicks: 0, vtc: 0, revenue: 0, rpc: 0, rpmv: 0 };

/** One v4 campaign row, flattened for the UI. */
function present(c) {
  return {
    id: String(c.id),
    name: c.name,
    status: c.status,
    type: 'rsoc',
    country: c.country?.code || '',
    countryName: c.country?.name || '',
    offer: c.offer?.name || '',
    offerId: c.offer?.id != null ? String(c.offer.id) : null,
    vertical: c.offer?.vertical?.name || '',
    imprint: c.imprint,
    created: c.created,
    // v3's `link` is gone entirely in v4; directLink is the only one that matters.
    directLink: c.directLink || null,
    trackingLink: c.trackingLink || null,
    targetDomain: c.targetDomain || null,
    keywordAmount: c.keywordAmount ?? null,
    keywords: Array.isArray(c.keywords) ? c.keywords : [],
    s2sCallbacks: c.s2sCallbacks || {},
    trackingTarget: c.traffic?.trackingTarget || null,
    article: c.article || null,
    articleId: c.article?.id ?? null,
    stats: c.stats || null,
  };
}

// ─── List ────────────────────────────────────────────────────────────────────

/**
 * `state` is required by v4 and accepts a comma-separated list, so the several
 * requests this used to make (one per state) are now a single call. With
 * stats=true each row carries its own metrics — no second report to join.
 */
router.get('/', asyncRoute(async (req, res) => {
  const state = req.query.state || 'active';
  const wantStats = req.query.stats !== 'false' && Boolean(req.query.from || req.query.stats);

  const { data, pagination } = await getV4Client().getCampaigns({
    state,
    stats: wantStats,
    from: req.query.from,
    to: req.query.to,
    limit: Math.min(Number(req.query.limit) || 100, 100),
    offset: Number(req.query.offset) || 0,
    // Search is done by Tonic, not in the browser, so it covers every page
    // rather than only the rows already loaded.
    campaignName: req.query.campaignName,
    campaignIds: req.query.campaignIds,
    orderField: req.query.orderField,
    orderOrientation: req.query.orderOrientation,
  });

  const local = new Map(campaigns.list().map((c) => [String(c.tonic_campaign_id), c]));
  const rows = (Array.isArray(data) ? data : []).map((c) => {
    const row = present(c);
    return {
      ...row,
      stats: row.stats || (wantStats ? emptyStats : null),
      articleRequestId: local.get(row.id)?.article_request_id ?? null,
    };
  });

  res.json({ rows, pagination });
}));

/** Campaigns this app launched, from the local mirror. */
router.get('/launched', (req, res) => res.json(campaigns.list()));

/** v4 has no per-campaign endpoint; filter the list to one id. */
router.get('/:id/status', asyncRoute(async (req, res) => {
  const { data } = await getV4Client().getCampaigns({
    state: 'pending,active,stopped,deleted',
    campaignIds: req.params.id,
  });
  const found = (Array.isArray(data) ? data : [])[0];
  if (!found) return res.status(404).json({ error: 'Campaign not found.' });

  const row = present(found);
  campaigns.update(req.params.id, { status: row.status, direct_link: row.directLink });
  res.json({ status: row.status, directLink: row.directLink, campaign: row });
}));

// ─── Create ──────────────────────────────────────────────────────────────────

/**
 * v4 derives offer and country from the article, so creating a campaign needs
 * only a name and an article id.
 */
router.post('/', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const articleId = body.articleId ?? body.headlineId;

  const fields = {};
  if (!name) fields.name = 'Give the campaign a name.';
  else if (name.length > 100) fields.name = 'Keep the name to 100 characters or fewer.';
  if (!articleId) fields.headlineId = 'Choose a published article.';
  if (Object.keys(fields).length) {
    return res.status(400).json({ error: 'Please correct the highlighted fields.', fields });
  }

  const { data } = await getV4Client().createCampaign({
    name, articleId, imprint: body.imprint,
  });
  const row = present(data || {});

  const linked = body.articleRequestId ? articleRequests.byId(body.articleRequestId) : null;
  const saved = campaigns.create({
    tonic_campaign_id: row.id || null,
    name,
    headline_id: String(articleId),
    article_request_id: linked?.id ?? null,
    offer_id: row.offerId,
    offer_name: row.offer,
    country: row.country,
    status: row.status || 'pending',
    direct_link: row.directLink,
  });

  res.status(201).json({ ...saved, ...row, directLink: row.directLink });
}));

// ─── Update: rename, status, keywords, callbacks, tracking target ────────────

/** Everything v3 spread across four endpoints now goes through PATCH. */
async function patchOne(id, dataset) {
  const { data } = await getV4Client().patchCampaigns([{ id: Number(id), ...dataset }]);
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  return rows[0] ? present(rows[0]) : null;
}

router.patch('/:id', asyncRoute(async (req, res) => {
  const { name, status } = req.body || {};
  const dataset = {};
  if (name !== undefined) dataset.name = String(name).trim();
  if (status !== undefined) dataset.status = status;      // active | stopped
  if (!Object.keys(dataset).length) {
    return res.status(400).json({ error: 'Nothing to update.' });
  }
  res.json(await patchOne(req.params.id, dataset) ?? { ok: true });
}));

router.get('/:id/keywords', asyncRoute(async (req, res) => {
  const { data } = await getV4Client().getCampaigns({
    state: 'pending,active,stopped', campaignIds: req.params.id,
  });
  const c = (Array.isArray(data) ? data : [])[0];
  if (!c) return res.status(404).json({ error: 'Campaign not found.' });
  res.json({ amount: c.keywordAmount ?? 6, keywords: Array.isArray(c.keywords) ? c.keywords : [] });
}));

router.put('/:id/keywords', asyncRoute(async (req, res) => {
  const amount = Number(req.body?.amount ?? 6);
  const keywords = (req.body?.keywords || []).map((k) => String(k || '').trim()).filter(Boolean);

  if (!Number.isInteger(amount) || amount < KEYWORD_MIN || amount > KEYWORD_MAX) {
    return res.status(400).json({
      error: `Keyword amount must be between ${KEYWORD_MIN} and ${KEYWORD_MAX}.`,
      fields: { amount: 'Out of range.' },
    });
  }
  if (keywords.length > amount) {
    return res.status(400).json({
      error: `You have ${keywords.length} keywords but the amount is set to ${amount}.`,
      fields: { keywords: 'Raise the amount or remove some keywords.' },
    });
  }

  const row = await patchOne(req.params.id, { keywordAmount: amount, keywords });
  res.json({ amount: row?.keywordAmount ?? amount, keywords: row?.keywords ?? keywords });
}));

router.get('/:id/callbacks', asyncRoute(async (req, res) => {
  const { data } = await getV4Client().getCampaigns({
    state: 'pending,active,stopped', campaignIds: req.params.id,
  });
  const c = (Array.isArray(data) ? data : [])[0];
  if (!c) return res.status(404).json({ error: 'Campaign not found.' });

  const stored = c.s2sCallbacks || {};
  const callbacks = {};
  for (const k of CALLBACK_KEYS) callbacks[k] = stored[k] || '';
  res.json({ campaignId: req.params.id, callbacks, types: CALLBACK_KEYS });
}));

/**
 * v4 takes all seven at once, so the diff-and-delete dance v3 required is gone:
 * send the whole object, null clears an event.
 */
router.put('/:id/callbacks', asyncRoute(async (req, res) => {
  const incoming = req.body?.callbacks || {};
  const unknown = Object.keys(incoming).filter((k) => !CALLBACK_KEYS.includes(k));
  if (unknown.length) {
    return res.status(400).json({ error: `Unknown callback type: ${unknown.join(', ')}` });
  }

  const invalid = Object.entries(incoming)
    .filter(([, url]) => url && !/^https?:\/\//i.test(String(url).trim()))
    .map(([k]) => k);
  if (invalid.length) {
    return res.status(400).json({
      error: 'Callback URLs must begin with http:// or https://',
      fields: Object.fromEntries(invalid.map((k) => [k, 'Must start with http:// or https://'])),
    });
  }

  const s2sCallbacks = {};
  for (const k of CALLBACK_KEYS) {
    const v = String(incoming[k] ?? '').trim();
    s2sCallbacks[k] = v || null;
  }

  // Placeholders like {click_id} only resolve at runtime, so a live status
  // check on the URL would fail for a URL that is actually correct.
  const skipStatusCheck = Object.values(s2sCallbacks).some((v) => v && v.includes('{'));

  const row = await patchOne(req.params.id, { s2sCallbacks, skipStatusCheck });
  const saved = row?.s2sCallbacks || s2sCallbacks;
  const callbacks = {};
  for (const k of CALLBACK_KEYS) callbacks[k] = saved[k] || '';
  res.json({ callbacks, skipStatusCheck });
}));

/** Tracking target — no v3 equivalent existed at all. */
router.put('/:id/tracking-target', asyncRoute(async (req, res) => {
  const trackingTarget = req.body?.trackingTarget ?? null;
  const row = await patchOne(req.params.id, { traffic: { trackingTarget } });
  res.json({ trackingTarget: row?.trackingTarget ?? trackingTarget });
}));

export default router;
