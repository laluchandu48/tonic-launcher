/** Small helpers shared by the route modules. */
import { TonicV4Error } from './tonicV4.js';
import { FacebookError } from './facebook.js';
import { isConfigured } from './credentials.js';

/** Wrap an async handler so rejections reach the error middleware. */
export const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Block calls that would fail at Tonic anyway, with a clearer message. */
export function requireCredentials(req, res, next) {
  if (!isConfigured()) {
    return res.status(428).json({
      error: 'Tonic API credentials are not configured.',
      hint: 'Add them on the Settings screen.',
      code: 'NO_CREDENTIALS',
    });
  }
  next();
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof TonicV4Error) {
    // Surface upstream failures in the terminal too — the browser only shows
    // the message, and a network cause is worth seeing in the log.
    if (!err.status || err.status >= 500) console.warn('[tonic]', err.message, err.path || '');
    // Pass Tonic's own status through, except auth failures, which mean *our*
    // stored credentials are wrong rather than the caller being unauthorised.
    const status = err.status === 401 || err.status === 403 ? 502 : err.status || 502;
    return res.status(status).json({
      error: err.message,
      source: 'tonic',
      path: err.path,
      requestId: err.requestId ?? undefined,
    });
  }
  if (err instanceof FacebookError) {
    if (!err.status || err.status >= 500) console.warn('[facebook]', err.message, err.path || '');
    // A bad token is our stored credential being wrong, not the caller's fault.
    const status = err.status === 401 || err.status === 403 ? 502 : err.status || 502;
    return res.status(status).json({
      error: err.message,
      source: 'facebook',
      path: err.path,
      fbCode: err.code ?? undefined,
      traceId: err.traceId ?? undefined,
    });
  }

  console.error('[error]', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
}
