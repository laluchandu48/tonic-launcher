import { Router } from 'express';
import { asyncRoute } from '../lib/http.js';
import { users } from '../db/index.js';
import {
  hashPassword, verifyPassword, setSessionCookie, clearSessionCookie,
  currentUser, requireAuth, MIN_PASSWORD_LENGTH,
} from '../lib/auth.js';

const router = Router();

/** Who is signed in, if anyone. Used by the client to decide what to render. */
router.get('/me', (req, res) => {
  const user = currentUser(req);
  res.json({ user });
});

router.post('/login', asyncRoute(async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');

  const user = username ? users.byUsername(username) : null;
  const ok = user ? await verifyPassword(password, user) : false;

  // One message for a wrong name and a wrong password. Telling them apart
  // confirms which usernames exist, which is free reconnaissance.
  if (!ok) {
    // A deliberate pause blunts rapid guessing without a rate-limit table.
    await new Promise((r) => setTimeout(r, 400));
    return res.status(401).json({ error: 'That username and password do not match.' });
  }

  setSessionCookie(res, user);
  res.json({
    ok: true,
    user: { id: user.id, username: user.username, mustChange: Boolean(user.must_change) },
  });
}));

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.post('/password', requireAuth, asyncRoute(async (req, res) => {
  const current = String(req.body?.currentPassword || '');
  const next = String(req.body?.newPassword || '');

  const user = users.byId(req.user.id);
  if (!(await verifyPassword(current, user))) {
    return res.status(400).json({
      error: 'That is not your current password.',
      fields: { currentPassword: 'Incorrect.' },
    });
  }
  if (next.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({
      error: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
      fields: { newPassword: `At least ${MIN_PASSWORD_LENGTH} characters.` },
    });
  }
  if (next === current) {
    return res.status(400).json({
      error: 'The new password must be different.',
      fields: { newPassword: 'Choose a different password.' },
    });
  }

  const { salt, passwordHash } = await hashPassword(next);
  const updated = users.setPassword(user.id, { salt, passwordHash });

  // Issue a fresh cookie for this browser. Every cookie signed against the old
  // password is now invalid, which is what ends sessions elsewhere.
  setSessionCookie(res, updated);
  res.json({ ok: true });
}));

export default router;
