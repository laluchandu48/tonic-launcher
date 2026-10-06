import { Router } from 'express';
import { asyncRoute } from '../lib/http.js';
import {
  readFbSettings, saveFbSettings, clearFbSettings, isFbConfigured, rememberAdAccount,
  maskedToken, getFbClient, requireFbCredentials,
  KNOWN_JOIN_PARAMS, DEFAULT_API_VERSION, DEFAULT_JOIN_PARAM,
} from '../lib/fbCredentials.js';
import { FacebookClient } from '../lib/facebook.js';

const router = Router();

/** Never returns the token itself — only whether one exists, and a mask. */
router.get('/', (req, res) => {
  const { adAccountId, apiVersion, joinParam, fromEnv } = readFbSettings();
  res.json({
    configured: isFbConfigured(),
    maskedToken: maskedToken(),
    adAccountId,
    apiVersion,
    joinParam,
    fromEnv,
    knownJoinParams: KNOWN_JOIN_PARAMS,
    defaults: { apiVersion: DEFAULT_API_VERSION, joinParam: DEFAULT_JOIN_PARAM },
  });
});

router.post('/', asyncRoute(async (req, res) => {
  const { accessToken, apiVersion, joinParam } = req.body || {};
  const fields = {};

  const existing = readFbSettings();
  const token = (accessToken || '').trim() || existing.accessToken;

  if (!token) fields.accessToken = 'Paste an access token.';
  if (apiVersion && !/^v\d+\.\d+$/.test(String(apiVersion).trim())) {
    fields.apiVersion = 'Use a Graph API version such as v24.0.';
  }
  if (joinParam && !/^[A-Za-z0-9_.-]{1,40}$/.test(String(joinParam).trim())) {
    fields.joinParam = 'Use the parameter name only, such as subid2.';
  }
  if (Object.keys(fields).length) {
    return res.status(400).json({ error: 'Check the fields below.', fields });
  }

  // Prove the token works before storing it, so a bad paste surfaces here
  // rather than as an empty Final Data table later.
  const probe = new FacebookClient({
    accessToken: token,
    apiVersion: (apiVersion || existing.apiVersion || DEFAULT_API_VERSION).trim(),
  });
  const identity = await probe.verify();

  saveFbSettings({ accessToken, apiVersion, joinParam });
  res.json({ ok: true, identity, maskedToken: maskedToken() });
}));

router.post('/test', asyncRoute(async (req, res) => {
  if (!isFbConfigured()) {
    return res.status(428).json({ error: 'Nothing saved yet.', code: 'NO_FB_CREDENTIALS' });
  }
  res.json({ ok: true, identity: await getFbClient().verify() });
}));

/** Every ad account the token can read — what the Final Data picker lists. */
router.get('/accounts', requireFbCredentials, asyncRoute(async (req, res) => {
  const accounts = await getFbClient().getAdAccounts();
  res.json({ accounts, selected: readFbSettings().adAccountId });
}));

/** Remember the picker's choice so the screen opens where it was left. */
router.put('/account', requireFbCredentials, (req, res) => {
  const id = rememberAdAccount(req.body?.adAccountId);
  if (!id) return res.status(400).json({ error: 'Not a valid ad account ID.' });
  res.json({ ok: true, adAccountId: id });
});

router.delete('/', (req, res) => {
  clearFbSettings();
  res.json({ ok: true });
});

export default router;
