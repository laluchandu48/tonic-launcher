/**
 * One adset, one day, hour by hour.
 *
 * The hard part is not fetching either side; it is that they count hours on
 * different clocks. Meta aggregates its hourly breakdown in the ad account's
 * timezone and hands back fixed buckets. Tonic timestamps its sessions on its
 * own PST/PDT clock. Putting hour 14 from one beside hour 14 from the other
 * without converting would silently compare different hours — off by nine and
 * a half for an Indian ad account, and never obviously wrong on screen.
 *
 * Meta's buckets cannot be moved, so Tonic's timestamps are converted into the
 * account's timezone and bucketed there. The response says which timezone the
 * hours are in, and the page shows it, because an hourly table with no clock
 * named on it is not interpretable.
 */

/** Tonic's own clock: its session report's `date` is a PST/PDT day. */
export const TONIC_TZ = 'America/Los_Angeles';

/**
 * Read a wall-clock time in one timezone and return the real instant.
 *
 * `new Date('2026-10-30 14:05:00')` is read in the server's timezone, which is
 * whatever the machine happens to be set to. This pins it to Tonic's instead.
 */
export function instantFromWallTime(text, timeZone) {
  const normalised = String(text).trim().replace(' ', 'T');
  const asIfUtc = new Date(`${normalised}Z`);
  if (Number.isNaN(asIfUtc.getTime())) return null;

  // How far that timezone is from UTC at that moment, DST included.
  const tzView = new Date(asIfUtc.toLocaleString('en-US', { timeZone }));
  const utcView = new Date(asIfUtc.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(asIfUtc.getTime() + (utcView.getTime() - tzView.getTime()));
}

/** The instant a Tonic timestamp refers to, offset-carrying or not. */
export function tonicInstant(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  // An explicit offset or Z is authoritative; otherwise it is Tonic's clock.
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(raw)) {
    const d = new Date(raw.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return instantFromWallTime(raw, TONIC_TZ);
}

/** Which hour of the day an instant falls in, on a given clock. */
export function hourIn(instant, timeZone) {
  if (!instant) return null;
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', hourCycle: 'h23',
  }).format(instant);
  const n = Number(hour);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
}

/** And which calendar day, so sessions shifted across midnight can be dropped. */
export function dayIn(instant, timeZone) {
  if (!instant) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);
}

/**
 * Tonic sessions for one day, bucketed by hour on the account's clock.
 *
 * Fetched fresh rather than from the day cache: the cache stores a day summed
 * by adset, which is the wrong shape here, and a day is at most a few pages.
 */
export async function fetchTonicHours({ client, date, param, adsetId, timeZone, pageSize, maxPages }) {
  const columns = ['timestamp', 'clicks', 'estimation', `querystring.${param}`].join(',');
  const hours = new Map();
  let sessions = 0;
  let matched = 0;
  let offset = 0;
  let pages = 0;
  let outsideDay = 0;

  while (pages < maxPages) {
    const { data } = await client.getSessionReport({ date, columns, limit: pageSize, offset });
    const rows = Array.isArray(data) ? data : [];

    for (const r of rows) {
      sessions += 1;
      const key = String(
        r.querystring?.[param] ?? r[`querystring.${param}`] ?? r[param] ?? ''
      ).trim();
      if (key !== String(adsetId)) continue;

      const instant = tonicInstant(r.timestamp);
      const hour = hourIn(instant, timeZone);
      if (hour == null) continue;

      /* Converting into another timezone can push a session into the previous
         or next calendar day. Those belong to that day's table, not this one,
         so they are counted and reported rather than folded into hour 0. */
      if (dayIn(instant, timeZone) !== date) {
        outsideDay += 1;
        continue;
      }

      matched += 1;
      const acc = hours.get(hour) || { hour, sessions: 0, conversions: 0, revenue: 0 };
      acc.sessions += 1;
      acc.conversions += Number(r.clicks) || 0;
      acc.revenue += Number(r.estimation) || 0;
      hours.set(hour, acc);
    }

    pages += 1;
    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  return { hours, sessions, matched, outsideDay, truncated: pages >= maxPages };
}
