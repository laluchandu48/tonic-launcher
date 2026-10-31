/**
 * The Tonic account itself: who you are, the API credentials you have issued,
 * and whether Tonic can reach your ad accounts.
 *
 * This mirrors three tabs of Tonic's own Settings screen. Two things it
 * deliberately does not mirror, because v4 offers no way to:
 *
 *   - Connecting a business portfolio. That is an OAuth handshake on Tonic's
 *     own site, with no API behind it, so the page links out rather than
 *     pretending to a button that cannot work.
 *   - Listing the portfolios already connected. There is an endpoint to check
 *     one account and one to revoke, but none that enumerates them — so the
 *     page asks which accounts to check instead of showing a list it cannot
 *     obtain.
 */
import { Router } from 'express';
import { asyncRoute, requireCredentials } from '../lib/http.js';
import { getV4Client } from '../lib/credentials.js';

const router = Router();
router.use(requireCredentials);

/** Tonic's own managed-access providers. */
const PROVIDERS = new Set(['facebook', 'tiktok']);

/** How many accounts the checker will take at once, matching Tonic's own tool. */
const MAX_CHECK = 10;

const first = (data) => (Array.isArray(data) ? data[0] : data) || {};

/**
 * Show enough of a key to recognise it and not enough to use it.
 *
 * v4 returns these in full on the list endpoint. The browser is given the
 * masked form, and the full value only when it is explicitly asked for — a
 * list of credentials is something you glance at far more often than you copy
 * from, and a secret that is merely on screen ends up in screenshots.
 */
export function maskSecret(value, start) {
  const text = String(value || '');
  const head = String(start || text.slice(0, 4));
  if (!text) return null;
  return `${head}${'•'.repeat(8)}${text.slice(-4)}`;
}

export function presentCredential(c) {
  return {
    id: c.id,
    name: c.name || null,
    description: c.description || null,
    validUntil: c.validUntil || null,
    consumerKeyMasked: maskSecret(c.consumerKey, c.consumerKeyStart),
    consumerSecretMasked: maskSecret(c.consumerSecret, c.consumerSecretStart),
  };
}

/** The account, trimmed to what the screen shows. */
export function presentAccount(a) {
  return {
    email: a.email || null,
    firstName: a.firstName || '',
    lastName: a.lastName || '',
    network: a.network || null,
    isSubUser: Boolean(a.isSubUser),
    subUserRole: a.subUserRole?.name || null,
    availableCampaignTypes: a.availableCampaignTypes || [],
    remainingCampaigns: a.remainingCampaigns || {},
    rsocDomains: (a.availableRsocDomains || []).map((d) => d.domain).filter(Boolean),
  };
}

// ─── Account settings ────────────────────────────────────────────────────────

router.get('/', asyncRoute(async (req, res) => {
  const { data } = await getV4Client().getAccount();
  res.json(presentAccount(first(data)));
}));

router.patch('/', asyncRoute(async (req, res) => {
  const fields = {};
  const firstName = req.body?.firstName;
  const lastName = req.body?.lastName;

  /* v4 accepts only these two, and bounces anything outside 1–60 characters.
     Checking here turns a 400 from Tonic into a message beside the field. */
  for (const [key, value] of Object.entries({ firstName, lastName })) {
    if (value === undefined) continue;
    const text = String(value).trim();
    if (text.length < 1 || text.length > 60) {
      fields[key] = 'Between 1 and 60 characters.';
    }
  }
  if (Object.keys(fields).length) {
    return res.status(400).json({ error: 'Check the fields below.', fields });
  }
  if (firstName === undefined && lastName === undefined) {
    return res.status(400).json({ error: 'Nothing to change.' });
  }

  const { data } = await getV4Client().patchAccount({
    firstName: firstName === undefined ? undefined : String(firstName).trim(),
    lastName: lastName === undefined ? undefined : String(lastName).trim(),
  });
  res.json(presentAccount(first(data)));
}));

// ─── API credentials ─────────────────────────────────────────────────────────

router.get('/api-credentials', asyncRoute(async (req, res) => {
  const { data } = await getV4Client().getApiCredentials();
  const rows = (Array.isArray(data) ? data : []).map(presentCredential);
  res.json({ rows });
}));

/** The full key and secret, fetched only when someone asks to see them. */
router.get('/api-credentials/:id/reveal', asyncRoute(async (req, res) => {
  const { data } = await getV4Client().getApiCredential(req.params.id);
  const c = first(data);
  res.json({
    id: c.id,
    consumerKey: c.consumerKey || null,
    consumerSecret: c.consumerSecret || null,
  });
}));

router.post('/api-credentials', asyncRoute(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const description = String(req.body?.description || '').trim();
  const months = Number(req.body?.months);

  const fields = {};
  if (!name) fields.name = 'Give the credential a name.';
  else if (name.length > 100) fields.name = '100 characters or fewer.';
  if (description.length > 500) fields.description = '500 characters or fewer.';
  if (![3, 6, 9, 12].includes(months)) fields.months = 'Choose 3, 6, 9 or 12 months.';
  if (Object.keys(fields).length) {
    return res.status(400).json({ error: 'Check the fields below.', fields });
  }

  /* v4 wants a date, not a duration, and refuses anything beyond twelve
     months. Built from today rather than from the browser's clock, so a
     device with the wrong date cannot produce a credential that is already
     expired or rejected. */
  const until = new Date();
  until.setMonth(until.getMonth() + months);
  const validUntil = until.toISOString().slice(0, 10);

  const { data } = await getV4Client().createApiCredential({ name, description, validUntil });
  const c = first(data);

  /* The one moment the secret is returned in full: right after creation,
     because this is the only time it can be copied and stored. */
  res.json({
    created: presentCredential(c),
    secretOnce: { consumerKey: c.consumerKey || null, consumerSecret: c.consumerSecret || null },
    validUntil,
  });
}));

router.delete('/api-credentials/:id', asyncRoute(async (req, res) => {
  await getV4Client().deleteApiCredential(req.params.id);
  res.json({ ok: true, id: req.params.id });
}));

// ─── Network access ──────────────────────────────────────────────────────────

const requireProvider = (req, res, next) => {
  if (!PROVIDERS.has(String(req.params.provider))) {
    return res.status(400).json({ error: 'Unknown provider.' });
  }
  next();
};

router.get('/managed-access/:provider', requireProvider, asyncRoute(async (req, res) => {
  const { data } = await getV4Client().getManagedAccess(req.params.provider);
  const d = first(data);
  res.json({ provider: d.provider || req.params.provider, connected: Boolean(d.connected) });
}));

/**
 * Check several ad accounts at once.
 *
 * v4 checks one per call, so this loops — serially, because these go to the
 * same upstream and a burst of ten is how rate limits get hit. One account
 * failing reports its own error rather than failing the batch.
 */
router.post('/managed-access/:provider/check', requireProvider, asyncRoute(async (req, res) => {
  const raw = req.body?.accountIds;
  const ids = (Array.isArray(raw) ? raw : String(raw || '').split(/[\s,]+/))
    .map((v) => String(v).trim())
    .filter(Boolean);

  if (!ids.length) return res.status(400).json({ error: 'Give at least one account ID.' });
  if (ids.length > MAX_CHECK) {
    return res.status(400).json({ error: `Up to ${MAX_CHECK} accounts at a time.` });
  }

  const results = [];
  for (const accountId of [...new Set(ids)]) {
    try {
      const { data } = await getV4Client().getManagedAccessAccount(req.params.provider, accountId);
      const d = first(data);
      results.push({
        accountId: d.accountId || accountId,
        state: d.state || null,
        explanation: d.explanation || null,
        lastUpdate: d.lastUpdate || null,
      });
    } catch (err) {
      results.push({ accountId, state: null, error: err.message });
    }
  }

  res.json({
    provider: req.params.provider,
    results,
    note: 'It can take a few hours after connecting an account before it appears here, '
      + 'and longer before its status is up to date.',
  });
}));

router.delete('/managed-access/:provider/credentials', requireProvider, asyncRoute(async (req, res) => {
  const identifier = String(req.query.identifier || '').trim();
  if (!identifier) return res.status(400).json({ error: 'Which credential should be revoked?' });
  await getV4Client().revokeManagedAccess(req.params.provider, identifier);
  res.json({ ok: true, provider: req.params.provider, identifier });
}));

export default router;
