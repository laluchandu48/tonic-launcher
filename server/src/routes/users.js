/**
 * People who can sign in.
 *
 * An admin runs the place. A viewer sees Final Data for the ad accounts they
 * have been assigned and nothing else — no settings, no API credentials, no
 * writes. That separation is enforced in the auth layer, not here; this route
 * only decides who is which.
 *
 * There is no mail server, so a new user's password is shown to the admin once
 * and passed on by hand. Saying so plainly beats a "we've emailed them" that
 * never arrives.
 */
import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { asyncRoute } from '../lib/http.js';
import { users, presentUser, ROLES } from '../db/index.js';
import { hashPassword, requireAdmin } from '../lib/auth.js';
import { normaliseAdAccountId } from '../lib/facebook.js';

const router = Router();
router.use(requireAdmin);

/** Readable, not clever: this gets typed into a login box by hand. */
function generatePassword() {
  return randomBytes(12).toString('base64url');
}

/**
 * Good enough to catch a typo, not an attempt at RFC 5322.
 *
 * The address is a login name here, not something we deliver mail to, so a
 * strict pattern would only reject valid addresses for no benefit.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** The ad accounts a viewer may see, normalised and de-duplicated. */
export function cleanAccounts(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(normaliseAdAccountId).filter(Boolean))];
}

router.get('/', (req, res) => {
  res.json({ rows: users.list().map(presentUser) });
});

router.post('/', asyncRoute(async (req, res) => {
  const email = String(req.body?.email || '').trim();
  const role = ROLES.includes(req.body?.role) ? req.body.role : 'viewer';
  const adAccounts = cleanAccounts(req.body?.adAccounts);

  const fields = {};
  if (!email) fields.email = 'Enter an email address.';
  else if (!EMAIL.test(email)) fields.email = 'That does not look like an email address.';
  else if (users.byEmail(email)) fields.email = 'Someone already uses that address.';
  if (Object.keys(fields).length) {
    return res.status(400).json({ error: 'Check the fields below.', fields });
  }

  /* The username is derived from the address so the column stays unique and
     populated, but it is the email people actually sign in with. */
  let username = email.split('@')[0].slice(0, 40) || 'user';
  while (users.byUsername(username)) username = `${username}${Math.floor(Math.random() * 90 + 10)}`;

  const password = generatePassword();
  const { salt, passwordHash } = await hashPassword(password);

  const created = users.create({
    username, email, role, adAccounts, passwordHash, salt, mustChange: 1,
  });

  /* Returned exactly once. It is not stored anywhere in readable form, so
     this response is the only chance to pass it on. */
  res.json({ user: presentUser(created), temporaryPassword: password });
}));

router.patch('/:id', asyncRoute(async (req, res) => {
  const user = users.byId(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'No such user.' });

  if (req.body?.adAccounts !== undefined) {
    users.setAdAccounts(user.id, cleanAccounts(req.body.adAccounts));
  }

  if (req.body?.active !== undefined) {
    const active = Boolean(req.body.active);
    /* Suspending the last admin would lock everyone out of the settings with
       no way back in short of editing the database by hand. */
    if (!active && user.role === 'admin' && users.activeAdminCount() <= 1) {
      return res.status(400).json({ error: 'This is the only active admin, so it cannot be suspended.' });
    }
    if (!active && user.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot suspend your own account.' });
    }
    users.setActive(user.id, active);
  }

  res.json({ user: presentUser(users.byId(user.id)) });
}));

/** A new temporary password, shown once, which they must then change. */
router.post('/:id/password', asyncRoute(async (req, res) => {
  const user = users.byId(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'No such user.' });

  const password = generatePassword();
  const { salt, passwordHash } = await hashPassword(password);
  users.setTemporaryPassword(user.id, { passwordHash, salt });

  /* Every session signed against the old password stops working, here as
     everywhere else — which is the point of resetting one. */
  res.json({ user: presentUser(users.byId(user.id)), temporaryPassword: password });
}));

router.delete('/:id', (req, res) => {
  const user = users.byId(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'No such user.' });
  if (user.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }
  if (user.role === 'admin' && users.activeAdminCount() <= 1) {
    return res.status(400).json({ error: 'This is the only active admin, so it cannot be deleted.' });
  }
  users.remove(user.id);
  res.json({ ok: true, id: user.id });
});

export default router;
