import { Router } from 'express';
import { asyncRoute, requireCredentials } from '../lib/http.js';
import { getV4Client } from '../lib/credentials.js';
import { articleRequests } from '../db/index.js';

const router = Router();
router.use(requireCredentials);

const MIN_PHRASES = 3;
const MAX_PHRASES = 5;
const LANGUAGE_PATTERN = /^[a-z]{2}(-[a-z]{2,8})?$/i;

/**
 * v4 returns the full request list with status and rejection reason, so this is
 * read live rather than mirrored. The local table is still written on create —
 * it is the only record of an attempt Tonic rejected outright, which never gets
 * an id and so never appears in the remote list.
 */
function validate(body) {
  const errors = {};
  const phrases = (body.contentGenerationPhrases || body.phrases || [])
    .map((p) => String(p || '').trim())
    .filter(Boolean);

  if (!body.offerId) errors.offerId = 'Choose an offer.';
  if (!body.country && !body.countryCode) errors.country = 'Choose a country (WO for worldwide).';
  if (!body.language) errors.language = 'Choose a language.';
  else if (!LANGUAGE_PATTERN.test(body.language)) errors.language = 'Use a language code such as "en".';
  if (!body.domain) errors.domain = 'Choose a domain.';

  if (phrases.length < MIN_PHRASES || phrases.length > MAX_PHRASES) {
    errors.contentGenerationPhrases = `Provide between ${MIN_PHRASES} and ${MAX_PHRASES} content generation phrases.`;
  }
  const title = body.headline ?? body.title;
  if (title && title.length > 256) errors.headline = 'The title must be 256 characters or fewer.';

  if (body.teaser) {
    if (body.teaser.length < 250) errors.teaser = 'The teaser must be at least 250 characters.';
    else if (body.teaser.length > 1000) errors.teaser = 'The teaser must be 1000 characters or fewer.';
  }
  return { errors, phrases, title };
}

/** Shape a v4 ArticleRequest the way the front end already expects. */
function present(r) {
  return {
    id: r.id,
    tonic_request_id: r.id != null ? String(r.id) : null,
    headline_id: r.articleId ?? null,
    articleId: r.articleId ?? null,
    status: r.status ?? 'pending',
    offer_id: r.offer?.id != null ? String(r.offer.id) : null,
    offer_name: r.offer?.name || null,
    vertical_name: r.offer?.vertical?.name || null,
    country: r.country?.code || null,
    countryName: r.country?.name || null,
    language: r.language || null,
    domain: r.domain || null,
    headline: r.title || null,
    phrases: r.phrases || [],
    error: r.rejectionReason || null,
    created_at: r.created || null,
  };
}

router.get('/', asyncRoute(async (req, res) => {
  const { data, pagination } = await getV4Client().getArticleRequests({
    limit: Math.min(Number(req.query.limit) || 50, 100),
    offset: Number(req.query.offset) || 0,
    status: req.query.status,
    language: req.query.language,
    countryCodes: req.query.countryCodes,
    orderField: req.query.orderField || 'created',
    orderOrientation: req.query.orderOrientation || 'desc',
  });

  const remote = (Array.isArray(data) ? data : []).map(present);

  // Attempts Tonic refused outright never got an id, so they exist only locally.
  const localOnly = articleRequests.list()
    .filter((r) => !r.tonic_request_id && r.error)
    .map((r) => ({ ...r, status: 'rejected' }));

  res.json({ rows: [...localOnly, ...remote], pagination });
}));

router.get('/:id', asyncRoute(async (req, res) => {
  const { data } = await getV4Client().getArticleRequest(req.params.id);
  res.json(present(data || {}));
}));

router.post('/', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const { errors, phrases, title } = validate(body);
  if (Object.keys(errors).length) {
    return res.status(400).json({ error: 'Please correct the highlighted fields.', fields: errors });
  }

  // v4 renames nearly every field compared with v3's rsoc/create.
  const payload = {
    countryCode: body.countryCode || body.country,
    offerId: Number(body.offerId),
    domain: body.domain,
    language: body.language,
    phrases,
  };
  if (title?.trim()) payload.title = title.trim();
  if (body.teaser?.trim()) payload.teaser = body.teaser.trim();

  // v3 took an array of citation links; v4 takes exactly one.
  const citation = body.citationLink || (body.citationLinks || [])[0];
  if (citation) payload.citationLink = citation;

  let created;
  try {
    const result = await getV4Client().createArticleRequest(payload);
    created = result.data;
  } catch (err) {
    articleRequests.create({
      status: 'rejected',
      offer_id: String(payload.offerId),
      offer_name: body.offerName ?? null,
      country: payload.countryCode,
      language: payload.language,
      domain: payload.domain,
      headline: payload.title ?? null,
      teaser: payload.teaser ?? null,
      phrases,
      citation_links: citation ? [citation] : [],
      error: err.message,
    });
    throw err;
  }

  const row = present(created || {});
  articleRequests.create({
    tonic_request_id: row.tonic_request_id,
    status: row.status,
    offer_id: row.offer_id ?? String(payload.offerId),
    offer_name: row.offer_name ?? body.offerName ?? null,
    country: row.country ?? payload.countryCode,
    language: row.language ?? payload.language,
    domain: row.domain ?? payload.domain,
    headline: row.headline ?? payload.title ?? null,
    teaser: payload.teaser ?? null,
    phrases,
    citation_links: citation ? [citation] : [],
  });

  res.status(201).json(row);
}));

/** Refused with 409 while a campaign still uses the article. */
router.delete('/article/:articleId', asyncRoute(async (req, res) => {
  await getV4Client().deleteArticle(req.params.articleId);
  res.json({ deleted: true });
}));

export default router;
