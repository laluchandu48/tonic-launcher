/**
 * Local persistence. Everything the app knows lives here; Tonic remains the
 * source of truth for campaigns, we just keep a local mirror so the dashboard
 * can show history and link article requests to the campaigns they produced.
 *
 * All access goes through the exported repositories. Nothing else in the app
 * touches SQL, so moving to RDS Postgres later means rewriting this file only.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATABASE_PATH || resolve(here, '../../data/tonic-launcher.db');

mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

// WAL is the right mode on a normal local disk. On network/synced mounts the
// extra -wal/-shm files can fail to lock, so fall back rather than refusing to
// start; 'delete' journaling is slower but works everywhere.
try {
  db.pragma('journal_mode = WAL');
} catch (err) {
  console.warn(`[db] WAL unavailable (${err.code || err.message}); using rollback journal.`);
  db.pragma('journal_mode = DELETE');
}
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS article_requests (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    tonic_request_id   TEXT    UNIQUE,
    headline_id        TEXT,
    status             TEXT    NOT NULL DEFAULT 'pending',
    offer_id           TEXT,
    offer_name         TEXT,
    country            TEXT,
    language           TEXT,
    domain             TEXT,
    headline           TEXT,
    teaser             TEXT,
    phrases            TEXT,            -- JSON array
    citation_links     TEXT,            -- JSON array
    error              TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    tonic_campaign_id  TEXT    UNIQUE,
    name               TEXT    NOT NULL,
    headline_id        TEXT,
    article_request_id INTEGER REFERENCES article_requests(id) ON DELETE SET NULL,
    offer_id           TEXT,
    offer_name         TEXT,
    country            TEXT,
    status             TEXT    NOT NULL DEFAULT 'pending',
    direct_link        TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Cache for all-time revenue. Tonic caps a tracking report at 31 days, so
  -- the total is assembled month by month; finished months never change and
  -- are kept forever, while the current month is refetched.
  CREATE TABLE IF NOT EXISTS revenue_months (
    month       TEXT PRIMARY KEY,          -- YYYY-MM
    revenue     REAL NOT NULL DEFAULT 0,
    clicks      INTEGER NOT NULL DEFAULT 0,
    complete    INTEGER NOT NULL DEFAULT 0,
    fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Tonic's session report is one request per day and refuses anything older
  -- than 50 days, so a 30-day Final Data view would be 30 calls on every load.
  -- Each day is aggregated by the join parameter and kept; a day Tonic has
  -- finalised never changes again, so it is only ever fetched once.
  CREATE TABLE IF NOT EXISTS tonic_session_days (
    date       TEXT    NOT NULL,          -- YYYY-MM-DD (PST/PDT, Tonic's clock)
    param      TEXT    NOT NULL,          -- the tracking parameter grouped on
    key        TEXT    NOT NULL,          -- its value, e.g. a Facebook adset id
    sessions   INTEGER NOT NULL DEFAULT 0,
    clicks     INTEGER NOT NULL DEFAULT 0,
    revenue    REAL    NOT NULL DEFAULT 0,
    PRIMARY KEY (date, param, key)
  );

  CREATE TABLE IF NOT EXISTS tonic_session_day_status (
    date       TEXT    NOT NULL,
    param      TEXT    NOT NULL,
    complete   INTEGER NOT NULL DEFAULT 0,  -- past Tonic's lastFinalDate
    truncated  INTEGER NOT NULL DEFAULT 0,  -- hit the page cap; totals are low
    sessions   INTEGER NOT NULL DEFAULT 0,
    fetched_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (date, param)
  );

  -- Sign-in. One row per person; passwords are never stored, only a scrypt
  -- hash with a per-user salt.
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    salt          TEXT    NOT NULL,
    must_change   INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_requests_status ON article_requests(status);
  CREATE INDEX IF NOT EXISTS idx_campaigns_headline ON campaigns(headline_id);
`);

const json = {
  parse(value, fallback) {
    if (!value) return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
  },
  stringify(value) {
    return value == null ? null : JSON.stringify(value);
  },
};

// ─── Settings ────────────────────────────────────────────────────────────────

export const settings = {
  get(key) {
    return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
  },
  set(key, value) {
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(key, value);
  },
  delete(key) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  },
};

// ─── Article requests ────────────────────────────────────────────────────────

function hydrateRequest(row) {
  if (!row) return null;
  return {
    ...row,
    phrases: json.parse(row.phrases, []),
    citation_links: json.parse(row.citation_links, []),
  };
}

export const articleRequests = {
  create(data) {
    const info = db.prepare(`
      INSERT INTO article_requests
        (tonic_request_id, status, offer_id, offer_name, country, language, domain,
         headline, teaser, phrases, citation_links, error)
      VALUES
        (@tonic_request_id, @status, @offer_id, @offer_name, @country, @language, @domain,
         @headline, @teaser, @phrases, @citation_links, @error)
    `).run({
      tonic_request_id: data.tonic_request_id ?? null,
      status: data.status ?? 'pending',
      offer_id: data.offer_id ?? null,
      offer_name: data.offer_name ?? null,
      country: data.country ?? null,
      language: data.language ?? null,
      domain: data.domain ?? null,
      headline: data.headline ?? null,
      teaser: data.teaser ?? null,
      phrases: json.stringify(data.phrases ?? []),
      citation_links: json.stringify(data.citation_links ?? []),
      error: data.error ?? null,
    });
    return this.byId(info.lastInsertRowid);
  },

  byId(id) {
    return hydrateRequest(db.prepare('SELECT * FROM article_requests WHERE id = ?').get(id));
  },

  byTonicId(tonicRequestId) {
    return hydrateRequest(
      db.prepare('SELECT * FROM article_requests WHERE tonic_request_id = ?').get(String(tonicRequestId))
    );
  },

  list() {
    return db.prepare('SELECT * FROM article_requests ORDER BY created_at DESC, id DESC')
      .all().map(hydrateRequest);
  },

  /** Fold the latest status (and headline_id once published) back in from Tonic. */
  updateStatus(tonicRequestId, { status, headline_id }) {
    db.prepare(`
      UPDATE article_requests
         SET status      = COALESCE(?, status),
             headline_id = COALESCE(?, headline_id),
             updated_at  = datetime('now')
       WHERE tonic_request_id = ?
    `).run(status ?? null, headline_id ?? null, String(tonicRequestId));
    return this.byTonicId(tonicRequestId);
  },
};

// ─── Campaigns ───────────────────────────────────────────────────────────────

export const campaigns = {
  create(data) {
    const info = db.prepare(`
      INSERT INTO campaigns
        (tonic_campaign_id, name, headline_id, article_request_id, offer_id,
         offer_name, country, status, direct_link)
      VALUES
        (@tonic_campaign_id, @name, @headline_id, @article_request_id, @offer_id,
         @offer_name, @country, @status, @direct_link)
    `).run({
      tonic_campaign_id: data.tonic_campaign_id ?? null,
      name: data.name,
      headline_id: data.headline_id ?? null,
      article_request_id: data.article_request_id ?? null,
      offer_id: data.offer_id ?? null,
      offer_name: data.offer_name ?? null,
      country: data.country ?? null,
      status: data.status ?? 'pending',
      direct_link: data.direct_link ?? null,
    });
    return this.byId(info.lastInsertRowid);
  },

  byId(id) {
    return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  },

  list() {
    return db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC, id DESC').all();
  },

  update(tonicCampaignId, { status, direct_link }) {
    db.prepare(`
      UPDATE campaigns
         SET status      = COALESCE(?, status),
             direct_link = COALESCE(?, direct_link),
             updated_at  = datetime('now')
       WHERE tonic_campaign_id = ?
    `).run(status ?? null, direct_link ?? null, String(tonicCampaignId));
  },
};

// ─── Revenue month cache ─────────────────────────────────────────────────────

export const revenueMonths = {
  upsert({ month, revenue, clicks, complete }) {
    db.prepare(`
      INSERT INTO revenue_months (month, revenue, clicks, complete, fetched_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(month) DO UPDATE SET
        revenue    = excluded.revenue,
        clicks     = excluded.clicks,
        complete   = excluded.complete,
        fetched_at = datetime('now')
    `).run(month, revenue, clicks, complete ? 1 : 0);
  },

  all() {
    return db.prepare('SELECT * FROM revenue_months ORDER BY month').all();
  },

  /** Months already stored as final — these never need fetching again. */
  completeMonths() {
    return new Set(
      db.prepare('SELECT month FROM revenue_months WHERE complete = 1').all().map((r) => r.month)
    );
  },

  totals() {
    const row = db.prepare('SELECT SUM(revenue) AS revenue, SUM(clicks) AS clicks, COUNT(*) AS months FROM revenue_months').get();
    return {
      revenue: row?.revenue || 0,
      clicks: row?.clicks || 0,
      months: row?.months || 0,
    };
  },
};

export default db;


// ─── Tonic session days ──────────────────────────────────────────────────────

export const sessionDays = {
  /** What we know about one day, or null if it was never fetched. */
  status(date, param) {
    return db.prepare(
      'SELECT * FROM tonic_session_day_status WHERE date = ? AND param = ?'
    ).get(date, param) || null;
  },

  /**
   * Replace a day wholesale. A partial write would silently under-report, so
   * the delete and the inserts share one transaction.
   */
  replaceDay(date, param, rows, { complete = 0, truncated = 0, sessions = 0 } = {}) {
    const wipe = db.prepare('DELETE FROM tonic_session_days WHERE date = ? AND param = ?');
    const insert = db.prepare(`
      INSERT INTO tonic_session_days (date, param, key, sessions, clicks, revenue)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const mark = db.prepare(`
      INSERT INTO tonic_session_day_status (date, param, complete, truncated, sessions, fetched_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(date, param) DO UPDATE SET
        complete = excluded.complete, truncated = excluded.truncated,
        sessions = excluded.sessions, fetched_at = datetime('now')
    `);

    db.transaction(() => {
      wipe.run(date, param);
      for (const r of rows) {
        insert.run(date, param, r.key, r.sessions || 0, r.clicks || 0, r.revenue || 0);
      }
      mark.run(date, param, complete ? 1 : 0, truncated ? 1 : 0, sessions);
    })();
  },

  /** Everything in a date range, already summed per key. */
  range(from, to, param) {
    return db.prepare(`
      SELECT key,
             SUM(sessions) AS sessions,
             SUM(clicks)   AS clicks,
             SUM(revenue)  AS revenue
        FROM tonic_session_days
       WHERE param = ? AND date BETWEEN ? AND ?
       GROUP BY key
    `).all(param, from, to);
  },

  /** One key's day-by-day rows, for the per-adset history view. */
  byKey(from, to, param, key) {
    return db.prepare(`
      SELECT date, sessions, clicks, revenue
        FROM tonic_session_days
       WHERE param = ? AND key = ? AND date BETWEEN ? AND ?
       ORDER BY date
    `).all(param, String(key), from, to);
  },

  /** Dropped when the join parameter changes — the old grouping is meaningless. */
  clearParam(param) {
    db.prepare('DELETE FROM tonic_session_days WHERE param = ?').run(param);
    db.prepare('DELETE FROM tonic_session_day_status WHERE param = ?').run(param);
  },
};


// ─── Users ───────────────────────────────────────────────────────────────────

export const users = {
  byUsername(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim()) || null;
  },

  byId(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
  },

  count() {
    return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  },

  create({ username, passwordHash, salt, mustChange = 1 }) {
    const info = db.prepare(`
      INSERT INTO users (username, password_hash, salt, must_change)
      VALUES (?, ?, ?, ?)
    `).run(String(username).trim(), passwordHash, salt, mustChange ? 1 : 0);
    return this.byId(info.lastInsertRowid);
  },

  setPassword(id, { passwordHash, salt }) {
    db.prepare(`
      UPDATE users
         SET password_hash = ?, salt = ?, must_change = 0, updated_at = datetime('now')
       WHERE id = ?
    `).run(passwordHash, salt, id);
    return this.byId(id);
  },
};
