import { Router } from 'express';
import { asyncRoute, requireCredentials } from '../lib/http.js';
import { getV4Client } from '../lib/credentials.js';

const router = Router();
router.use(requireCredentials);

/**
 * v4 returns these already normalised — offers carry a nested vertical, and
 * countries carry both code and name — so there is far less reshaping here
 * than there was against v3.
 */

router.get('/offers', asyncRoute(async (req, res) => {
  const { data } = await getV4Client().getOffers({
    countryCode: req.query.country || req.query.countryCode,
    domain: req.query.domain,
  });
  const rows = Array.isArray(data) ? data : [];
  res.json(rows.map((o) => ({
    id: String(o.id),
    name: o.name,
    vertical: o.vertical?.name || '',
    verticalId: o.vertical?.id ?? null,
  })));
}));

router.get('/countries', asyncRoute(async (req, res) => {
  const { data } = await getV4Client().getCountries({ domain: req.query.domain });
  const rows = Array.isArray(data) ? data : [];
  res.json(rows.map((c) => ({ code: c.code, name: c.name || '' })));
}));

/**
 * v3 had a dedicated domains endpoint; in v4 the RSOC domains and the languages
 * each one accepts live on the account payload.
 */
router.get('/domains', asyncRoute(async (req, res) => {
  const { data } = await getV4Client().getAccount();
  const domains = data?.availableRsocDomains || [];
  res.json(domains.map((d) => ({ domain: d.domain, languages: d.languages || [] })));
}));

/**
 * Published articles. Kept at the /headlines path so the front end's campaign
 * picker does not care that v3's "headline" is v4's "article"; the id it needs
 * is now the article id.
 */
router.get('/headlines', asyncRoute(async (req, res) => {
  const { data, pagination } = await getV4Client().getArticles({
    limit: Math.min(Number(req.query.limit) || 100, 100),
    offset: Number(req.query.offset) || 0,
    countryCode: req.query.countryCode,
    language: req.query.language,
    offerIds: req.query.offerIds,
    // Newest first: the article you just had published is the one you are
    // almost always about to launch a campaign against.
    orderField: req.query.orderField || 'created',
    orderOrientation: req.query.orderOrientation || 'desc',
  });
  const rows = Array.isArray(data) ? data : [];
  res.json(rows.map((a) => ({
    articleId: a.id,
    // Front end still speaks "headline"; keep both so nothing breaks.
    headline_id: a.id,
    headline: a.title,
    title: a.title,
    url: a.url,
    language: a.language,
    country: a.country?.code || '',
    countryName: a.country?.name || '',
    offer_id: a.offer?.id != null ? String(a.offer.id) : null,
    offer_name: a.offer?.name || '',
    vertical_name: a.offer?.vertical?.name || '',
    connectedCampaigns: a.connectedCampaignsCount ?? 0,
    created: a.created,
    pagination,
  })));
}));

/** Account summary — campaign allowance, network, sub-user role. */
router.get('/account', asyncRoute(async (req, res) => {
  const { data } = await getV4Client().getAccount();
  res.json({
    email: data?.email ?? null,
    name: [data?.firstName, data?.lastName].filter(Boolean).join(' ') || null,
    network: data?.network ?? null,
    availableCampaignTypes: data?.availableCampaignTypes ?? [],
    remainingCampaigns: data?.remainingCampaigns ?? null,
    domains: data?.availableRsocDomains ?? [],
    isSubUser: Boolean(data?.isSubUser),
  });
}));

export default router;
