/**
 * Sign-in for the launcher.
 *
 * Deliberately small: one table, no third-party dependency, no token service.
 * The app guards live revenue figures, ad spend and the ability to create
 * campaigns, so it needs a door — but a door, not a security product.
 *
 * Passwords are hashed with scrypt from Node's own crypto module. scrypt is
 * memory-hard, which is the property that matters: a leaked hash is expensive
 * to attack even with a GPU. bcrypt would be equally fine but is a native
 * dependency, and this app already has one of those to compile on deploy.
 *
 * Sessions are a signed cookie rather than server-side state, so a restart
 * doesn't log everyone out and there is no session table to prune.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { settings, users, presentUser } from '../db/index.js';

const scrypt = promisify(scryptCb);

const KEY_LENGTH = 64;
const SESSION_SETTING = 'auth.session_secret';
const COOKIE_NAME = 'tl_session';
/** Long enough not to be a nuisance, short enough that a stolen laptop ages out. */
const SESSION_DAYS = 14;

export const MIN_PASSWORD_LENGTH = 8;

// ─── Passwords ───────────────────────────────────────────────────────────────

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, KEY_LENGTH);
  return { salt, passwordHash: hash.toString('hex') };
}

/**
 * Compared with timingSafeEqual rather than ===, so the time taken does not
 * leak how much of the hash matched.
 */
export async function verifyPassword(password, { salt, password_hash }) {
  if (!salt || !password_hash) return false;
  const expected = Buffer.from(password_hash, 'hex');
  const actual = await scrypt(password, salt, KEY_LENGTH);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ─── Sessions ────────────────────────────────────────────────────────────────

/**
 * The signing secret. Generated once and kept in the database, so sessions
 * survive a restart; set SESSION_SECRET in the environment to control it
 * explicitly (necessary if this ever runs as more than one process).
 */
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  let secret = settings.get(SESSION_SETTING);
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    settings.set(SESSION_SETTING, secret);
  }
  return secret;
}

const sign = (payload) => createHmac('sha256', sessionSecret()).update(payload).digest('hex');

/**
 * A short fingerprint of the stored password hash, carried inside the token.
 * Changing the password changes the hash, which changes this, which makes every
 * token issued under the old password fail — so a password change really does
 * end other sessions rather than merely issuing a fresh cookie here.
 */
const passwordFingerprint = (hash) =>
  createHmac('sha256', sessionSecret()).update(String(hash || '')).digest('hex').slice(0, 16);

function makeToken(user) {
  const expires = Date.now() + SESSION_DAYS * 86_400_000;
  const payload = `${user.id}.${expires}.${passwordFingerprint(user.password_hash)}`;
  return `${payload}.${sign(payload)}`;
}

/** Returns { id, fp }, or null for anything malformed, expired or forged. */
function readToken(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 4) return null;

  const [id, expires, fp, mac] = parts;
  const expected = sign(`${id}.${expires}.${fp}`);
  const a = Buffer.from(mac, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (!Number(expires) || Number(expires) < Date.now()) return null;

  return { id: Number(id) || null, fp };
}

/** Express has no cookie parser built in, and one header is not worth a dependency. */
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function setSessionCookie(res, user) {
  const parts = [
    `${COOKIE_NAME}=${makeToken(user)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 86_400}`,
  ];
  // Secure would stop the cookie working over plain HTTP, which is how this is
  // reached today. Set COOKIE_SECURE=1 once it is behind HTTPS.
  if (process.env.COOKIE_SECURE === '1') parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function currentUser(req) {
  const claim = readToken(readCookie(req, COOKIE_NAME));
  if (!claim?.id) return null;

  const user = users.byId(claim.id);
  if (!user) return null;
  // The token was signed against a password that has since changed.
  if (claim.fp !== passwordFingerprint(user.password_hash)) return null;
  // A suspended account keeps its cookie but stops being signed in.
  if (user.active === 0) return null;

  return presentUser(user);
}

/** Everything behind this needs a signed-in session. */
export function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Sign in to continue.', code: 'AUTH_REQUIRED' });
  }
  req.user = user;
  next();
}

/** Admin-only routes. Checked server-side: hiding a screen is not a guard. */
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admins only.', code: 'ADMIN_REQUIRED' });
  }
  next();
}

/**
 * A non-admin may reach Final Data and their own account, and nothing else.
 *
 * An allowlist rather than a blocklist: a route added next month is closed to
 * them until someone decides otherwise, which is the right default when what
 * sits behind these routes is the API credentials.
 */
const VIEWER_PATHS = [
  /^\/auth(\/|$)/,
  /^\/final-data(\/|$)/,
  /^\/stats\/today$/,
];

/**
 * What an editor may change: the budget and on/off controls on Final Data,
 * and nothing else. Spending money is the whole of the extra trust, so it is
 * written out rather than inferred from "not a viewer".
 */
const EDITOR_WRITES = [
  /^\/final-data\/budget\//,
  /^\/final-data\/adsets\/[^/]+\/status$/,
];

export function restrictViewers(req, res, next) {
  const role = req.user?.role;
  if (role !== 'viewer' && role !== 'editor') return next();

  const path = req.path;
  if (!VIEWER_PATHS.some((rx) => rx.test(path))) {
    return res.status(403).json({ error: 'Not available on this account.', code: 'FORBIDDEN' });
  }

  if (req.method === 'GET' || /^\/auth(\/|$)/.test(path)) return next();

  /* Signing out and changing your own password are writes too, which is what
     the /auth test above is for. Beyond those: an editor may change a budget
     or pause an adset; a viewer may change nothing. */
  if (role === 'editor' && EDITOR_WRITES.some((rx) => rx.test(path))) return next();

  return res.status(403).json({
    error: role === 'editor'
      ? 'This account can change budgets and adset status, nothing else.'
      : 'This account has read-only access.',
    code: 'READ_ONLY',
  });
}

// ─── First run ───────────────────────────────────────────────────────────────

/**
 * Create the first account if the table is empty. The password comes from the
 * environment so it is never committed; without one, a random password is
 * generated and printed to the server log exactly once.
 */
export async function ensureFirstUser() {
  if (users.count() > 0) return null;

  const username = process.env.INITIAL_USERNAME || 'Hitesh';
  const password = process.env.INITIAL_PASSWORD || randomBytes(12).toString('base64url');

  const { salt, passwordHash } = await hashPassword(password);
  // The first account runs the place.
  users.create({ username, role: 'admin', passwordHash, salt, mustChange: 1 });

  if (!process.env.INITIAL_PASSWORD) {
    console.log(`\n  Created the first account: ${username}`);
    console.log(`  Temporary password: ${password}`);
    console.log('  Change it on the Account screen after signing in.\n');
  }
  return username;
}
