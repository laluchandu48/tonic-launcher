import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { errorHandler } from './lib/http.js';
import { requireAuth, ensureFirstUser } from './lib/auth.js';
import authRoutes from './routes/auth.js';
import settingsRoutes from './routes/settings.js';
import lookupRoutes from './routes/lookups.js';
import articleRoutes from './routes/articles.js';
import campaignRoutes from './routes/campaigns.js';
import statsRoutes from './routes/stats.js';
import complianceRoutes from './routes/compliance.js';
import fbSettingsRoutes from './routes/fbSettings.js';
import finalDataRoutes from './routes/finalData.js';

const here = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 5050;

app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: '1mb' }));

// Health is public so a load balancer or uptime check can reach it; it says
// nothing about the account.
app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'tonic-launcher' }));

app.use('/api/auth', authRoutes);

// Everything past this point requires a signed-in session. Placing the guard
// here rather than on each router means a route added later is protected by
// default — the safer way round to forget something.
app.use('/api', requireAuth);

app.use('/api/settings', settingsRoutes);
app.use('/api/lookups', lookupRoutes);
app.use('/api/articles', articleRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/compliance', complianceRoutes);
app.use('/api/fb-settings', fbSettingsRoutes);
app.use('/api/final-data', finalDataRoutes);

// In production the built client is served by this same process, which keeps
// the AWS deployment to a single container.
const clientDist = resolve(here, '../../client/dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(resolve(clientDist, 'index.html'));
  });
}

app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.path}` }));
app.use(errorHandler);

ensureFirstUser()
  .catch((err) => console.error('[auth] could not create the first account:', err.message))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`\n  Tonic Launcher API  →  http://localhost:${PORT}`);
      console.log(`  Health              →  http://localhost:${PORT}/api/health\n`);
    });
  });
