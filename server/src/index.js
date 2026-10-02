import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { errorHandler } from './lib/http.js';
import settingsRoutes from './routes/settings.js';
import lookupRoutes from './routes/lookups.js';
import articleRoutes from './routes/articles.js';
import campaignRoutes from './routes/campaigns.js';
import statsRoutes from './routes/stats.js';
import complianceRoutes from './routes/compliance.js';

const here = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 5050;

app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'tonic-launcher' }));

app.use('/api/settings', settingsRoutes);
app.use('/api/lookups', lookupRoutes);
app.use('/api/articles', articleRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/compliance', complianceRoutes);

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

app.listen(PORT, () => {
  console.log(`\n  Tonic Launcher API  →  http://localhost:${PORT}`);
  console.log(`  Health              →  http://localhost:${PORT}/api/health\n`);
});
