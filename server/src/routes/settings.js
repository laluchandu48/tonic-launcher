import { Router } from 'express';
import { asyncRoute } from '../lib/http.js';
import { readCredentials, saveCredentials, clearCredentials, isConfigured, maskedKey, getV4Client } from '../lib/credentials.js';

const router = Router();

/** What the UI is allowed to know about the stored credentials. */
router.get('/', (req, res) => {
  const { fromEnv } = readCredentials();
  res.json({
    configured: isConfigured(),
    maskedKey: maskedKey(),
    managedByEnv: fromEnv,
  });
});

router.post('/credentials', asyncRoute(async (req, res) => {
  const consumerKey = String(req.body?.consumerKey || '').trim();
  const consumerSecret = String(req.body?.consumerSecret || '').trim();

  if (!consumerKey || !consumerSecret) {
    return res.status(400).json({ error: 'Both the consumer key and secret are required.' });
  }

  saveCredentials({ consumerKey, consumerSecret });

  // Prove they work before reporting success, so a typo surfaces here rather
  // than on the first article request.
  try {
    await getV4Client().authenticate({ force: true });
  } catch (err) {
    clearCredentials();
    return res.status(400).json({
      error: err.message || 'Those credentials were rejected by Tonic.',
      source: 'tonic',
    });
  }

  res.json({ configured: true, maskedKey: maskedKey(), managedByEnv: false });
}));

router.post('/test', asyncRoute(async (req, res) => {
  const client = getV4Client();
  await client.authenticate({ force: true });
  res.json({
    ok: true,
    tokenExpiresAt: new Date(client.accessExpiresAt).toISOString(),
  });
}));

router.delete('/credentials', (req, res) => {
  clearCredentials();
  res.json({ configured: false, maskedKey: null });
});

export default router;
