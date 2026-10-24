import { useCallback, useEffect, useMemo, useState } from 'react';
import Layout from '../components/Layout.jsx';
import CampaignTabs from '../components/CampaignTabs.jsx';
import SearchBox from '../components/SearchBox.jsx';
import Picker from '../components/Picker.jsx';
import { useToast } from '../components/Toast.jsx';
import { api } from '../lib/api.js';

/**
 * Keyword performance.
 *
 * A keyword usually runs in several campaigns at once, so the row is the
 * keyword and the campaigns live inside it. Expanding costs no request: the
 * campaigns, countries and offers all arrive with the row that drew it.
 *
 * Sorting and paging are the API's, not this page's. Sorting the 25 rows on
 * screen would sort that page alone, which looks exactly like a broken sort as
 * soon as there is a second page.
 */

/** v4 refuses a keyword range longer than 30 days, so nothing here offers one. */
const RANGES = {
  today: { label: 'Today', from: (t) => t, to: (t) => t },
  yesterday: { label: 'Yesterday', from: (t) => shift(t, -1), to: (t) => shift(t, -1) },
  last7: { label: 'Last 7 days', from: (t) => shift(t, -6), to: (t) => t },
  last14: { label: 'Last 14 days', from: (t) => shift(t, -13), to: (t) => t },
  last30: { label: 'Last 30 days', from: (t) => shift(t, -29), to: (t) => t },
  custom: { label: 'Custom range…', custom: true },
};

const PAGE_SIZES = [10, 25, 50, 100];

const COLUMNS = [
  { key: 'keyword', label: 'Keyword', sortable: true },
  { key: 'campaigns', label: 'Campaigns' },
  { key: 'offer', label: 'Campaign Offer' },
  { key: 'geo', label: 'Geo' },
  { key: 'clicks', label: 'Clicks', numeric: true, sortable: true },
  { key: 'rpc', label: 'RPC', numeric: true, sortable: true },
  { key: 'revenue', label: 'Revenue', numeric: true, sortable: true },
];

function shift(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const money = (n) => `${Number(n || 0).toFixed(2)} $`;
const int = (n) => Number(n || 0).toLocaleString();
const dash = <span className="muted">—</span>;

/**
 * A country code as its flag. The regional-indicator trick maps AB to 🇦🇧, and
 * the code stays in the title so a flag nobody recognises is still readable.
 */
function Flag({ code, name }) {
  if (!code || code.length !== 2) return <span className="muted">{code || '—'}</span>;
  const emoji = String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => 127_397 + c.charCodeAt(0))
  );
  return <span title={name || code} aria-label={name || code}>{emoji}</span>;
}

/** "UK_TC_19_Current Value and 2 other" — the way Tonic writes it. */
function campaignSummary(campaigns) {
  if (!campaigns.length) return dash;
  const [first, ...rest] = campaigns;
  return (
    <>
      {first.name}
      {rest.length > 0 && <span className="muted"> and {rest.length} other</span>}
    </>
  );
}

export default function Keywords() {
  const toast = useToast();

  const [rangeKey, setRangeKey] = useState('yesterday');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [today, setToday] = useState('');

  const [search, setSearch] = useState('');
  const [campaignName, setCampaignName] = useState('');
  const [country, setCountry] = useState('');
  const [offerId, setOfferId] = useState('');

  const [sort, setSort] = useState({ key: 'revenue', dir: 'desc' });
  const [limit, setLimit] = useState(25);
  const [offset, setOffset] = useState(0);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [needsCredentials, setNeedsCredentials] = useState(false);

  const [expanded, setExpanded] = useState(() => new Set());
  /** Per-row: whether the detail is grouped by campaign or by country. */
  const [grouping, setGrouping] = useState({});

  const [countries, setCountries] = useState([]);
  const [offers, setOffers] = useState([]);

  // Tonic's clock is PST/PDT; the browser's date asks for the wrong day for
  // anyone outside California.
  useEffect(() => {
    api.stats.today()
      .then((r) => setToday(r.today || new Date().toISOString().slice(0, 10)))
      .catch(() => setToday(new Date().toISOString().slice(0, 10)));
    api.lookups.countries().then(setCountries).catch(() => {});
    api.lookups.offers().then(setOffers).catch(() => {});
  }, []);

  const range = useMemo(() => {
    if (!today) return null;
    const r = RANGES[rangeKey];
    if (r.custom) {
      if (!customFrom || !customTo) return null;
      return customFrom <= customTo
        ? { from: customFrom, to: customTo }
        : { from: customTo, to: customFrom };
    }
    return { from: r.from(today), to: r.to(today) };
  }, [rangeKey, customFrom, customTo, today]);

  const load = useCallback(async () => {
    if (!range) return;
    setLoading(true);
    try {
      const res = await api.keywords.get({
        ...range,
        search,
        campaignName,
        countryCodes: country,
        offerIds: offerId,
        orderField: sort.key,
        orderOrientation: sort.dir,
        limit,
        offset,
      });
      setData(res);
      setNeedsCredentials(false);
      // Expanding is about a row on screen; keeping it across a reload would
      // open whatever row happened to land in that position.
      setExpanded(new Set());
    } catch (err) {
      if (err.code === 'NO_CREDENTIALS') setNeedsCredentials(true);
      else toast.error(err.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [range, search, campaignName, country, offerId, sort, limit, offset]);

  useEffect(() => { load(); }, [load]);

  /* Any change to what is being asked for sends you back to the first page —
     staying on page 7 of a different result set shows an empty table. */
  const reset = (fn) => (value) => { setOffset(0); fn(value); };

  const chooseRange = (key) => {
    if (key === 'custom' && today && (!customFrom || !customTo)) {
      setCustomFrom(shift(today, -6));
      setCustomTo(today);
    }
    setOffset(0);
    setRangeKey(key);
  };

  const toggleSort = (col) => {
    if (!col.sortable) return;
    setOffset(0);
    setSort((s) => (
      s.key === col.key
        ? { key: col.key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { key: col.key, dir: col.numeric ? 'desc' : 'asc' }
    ));
  };

  const toggleRow = (keyword) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(keyword)) next.delete(keyword); else next.add(keyword);
    return next;
  });

  const rows = data?.rows || [];
  const t = data?.totals;
  const filtered = Boolean(search || campaignName || country || offerId);
  const hasMore = rows.length === limit;

  const resetFilters = () => {
    setSearch('');
    setCampaignName('');
    setCountry('');
    setOfferId('');
    setOffset(0);
  };

  /** Each country this keyword touched, with the campaigns that carried it. */
  const byCountry = (row) => {
    const out = new Map();
    for (const c of row.campaigns) {
      const code = c.country || '—';
      const acc = out.get(code) || { code, name: c.countryName, campaigns: 0, clicks: 0, revenue: 0 };
      acc.campaigns += 1;
      acc.clicks += c.clicks;
      acc.revenue += c.revenue;
      out.set(code, acc);
    }
    return [...out.values()]
      .map((r) => ({ ...r, rpc: r.clicks > 0 ? r.revenue / r.clicks : null }))
      .sort((a, b) => b.revenue - a.revenue);
  };

  if (needsCredentials) {
    return (
      <Layout title="Campaigns">
        <CampaignTabs />
        <div className="banner banner-warn">
          <span>⚠</span>
          <div>Tonic credentials are not configured yet. Add them on the Settings screen.</div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout
      title="Campaigns"
      actions={
        <button className="btn btn-secondary" onClick={load} disabled={loading}>
          {loading && <span className="spinner" />}
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      }
    >
      <CampaignTabs />

      <div className="card">
        <div className="card-head" style={{ flexWrap: 'wrap', gap: 10 }}>
          <div className="toolbar" style={{ flexWrap: 'wrap' }}>
            <select
              value={rangeKey}
              onChange={(e) => chooseRange(e.target.value)}
              style={{ width: 'auto', minWidth: 150 }}
              aria-label="Date range"
            >
              {Object.entries(RANGES).map(([key, r]) => (
                <option key={key} value={key}>{r.label}</option>
              ))}
            </select>

            {RANGES[rangeKey].custom && (
              <div className="toolbar" style={{ gap: 6 }}>
                <input
                  type="date"
                  value={customFrom}
                  max={customTo || today || undefined}
                  onChange={(e) => { setOffset(0); setCustomFrom(e.target.value); }}
                  style={{ width: 'auto' }}
                  aria-label="Start date"
                />
                <span className="muted" style={{ fontSize: 12 }}>to</span>
                <input
                  type="date"
                  value={customTo}
                  min={customFrom || undefined}
                  max={today || undefined}
                  onChange={(e) => { setOffset(0); setCustomTo(e.target.value); }}
                  style={{ width: 'auto' }}
                  aria-label="End date"
                />
              </div>
            )}

            <SearchBox
              value={search}
              onSearch={reset(setSearch)}
              placeholder="Search keyword"
              minLength={2}
              width={220}
            />

            <SearchBox
              value={campaignName}
              onSearch={reset(setCampaignName)}
              placeholder="Campaign name"
              minLength={3}
              width={200}
            />

            <div style={{ width: 170 }}>
              <Picker
                value={country}
                onChange={reset(setCountry)}
                placeholder="Any GEO"
                searchPlaceholder="Type a country…"
                options={[
                  { value: '', label: 'Any GEO' },
                  ...countries.map((c) => ({ value: c.code, label: c.code, hint: c.name || '' })),
                ]}
              />
            </div>

            <div style={{ width: 200 }}>
              <Picker
                value={offerId}
                onChange={reset(setOfferId)}
                placeholder="Any offer"
                searchPlaceholder="Type an offer…"
                options={[
                  { value: '', label: 'Any offer' },
                  ...offers.map((o) => ({ value: String(o.id), label: o.name, hint: o.vertical || '' })),
                ]}
              />
            </div>

            {filtered && (
              <button className="btn btn-ghost" onClick={resetFilters}>Reset filters</button>
            )}
          </div>

          {data?.meta && (
            <div className="muted" style={{ fontSize: 12 }}>
              {data.meta.from} to {data.meta.to}
            </div>
          )}
        </div>

        {loading ? (
          <div className="empty">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="empty">
            <p>{filtered ? 'No keyword matches these filters.' : 'No keyword data in this range.'}</p>
            {filtered && <button className="btn btn-ghost" onClick={resetFilters}>Reset filters</button>}
          </div>
        ) : (
          <div className="table-scroll" style={{ '--table-min': '900px' }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 38 }} aria-label="Expand" />
                  {COLUMNS.map((col) => (
                    <th
                      key={col.key}
                      className={col.numeric ? 'num' : undefined}
                      aria-sort={sort.key === col.key
                        ? (sort.dir === 'asc' ? 'ascending' : 'descending')
                        : 'none'}
                    >
                      {col.sortable ? (
                        <button type="button" className="th-sort" onClick={() => toggleSort(col)}>
                          {col.label}
                          <span className={`sort-arrow ${sort.key === col.key ? 'on' : ''}`}>
                            {sort.key === col.key ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}
                          </span>
                        </button>
                      ) : col.label}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {rows.map((r) => {
                  const open = expanded.has(r.keyword);
                  const mode = grouping[r.keyword] || 'campaign';
                  return [
                    <tr key={r.keyword}>
                      <td>
                        <button
                          type="button"
                          className="icon-btn icon-btn-plain"
                          onClick={() => toggleRow(r.keyword)}
                          aria-expanded={open}
                          aria-label={open ? `Collapse ${r.keyword}` : `Expand ${r.keyword}`}
                          title={open ? 'Hide the campaigns' : 'Show the campaigns this keyword ran in'}
                        >
                          <span className={`disclosure-caret ${open ? 'open' : ''}`}>▸</span>
                        </button>
                      </td>
                      <td>{r.keyword}</td>
                      <td>{campaignSummary(r.campaigns)}</td>
                      <td>
                        {r.offers.length === 0 ? dash : (
                          <>
                            {r.offers[0].name}
                            {r.offers.length > 1 && (
                              <span className="muted"> and {r.offers.length - 1} other</span>
                            )}
                          </>
                        )}
                      </td>
                      <td>
                        {r.countries.length === 0 ? dash : (
                          <>
                            <Flag code={r.countries[0].code} name={r.countries[0].name} />
                            {r.countries.length > 1 && (
                              <span className="muted" style={{ fontSize: 11, marginLeft: 4 }}>
                                +{r.countries.length - 1}
                              </span>
                            )}
                          </>
                        )}
                      </td>
                      <td className="num">{int(r.clicks)}</td>
                      <td className="num">{r.rpc == null ? dash : money(r.rpc)}</td>
                      <td className="num">{money(r.revenue)}</td>
                    </tr>,

                    open && (
                      <tr key={`${r.keyword}-detail`} className="detail-row">
                        <td />
                        <td colSpan={COLUMNS.length}>
                          <div className="detail-head">
                            <span className="muted" style={{ fontSize: 12 }}>Grouping</span>
                            <div className="seg">
                              <button
                                type="button"
                                className={mode === 'campaign' ? 'on' : ''}
                                onClick={() => setGrouping((g) => ({ ...g, [r.keyword]: 'campaign' }))}
                                title="One row per campaign"
                              >
                                Campaign
                              </button>
                              <button
                                type="button"
                                className={mode === 'country' ? 'on' : ''}
                                onClick={() => setGrouping((g) => ({ ...g, [r.keyword]: 'country' }))}
                                title="One row per country"
                              >
                                Country
                              </button>
                            </div>
                          </div>

                          <table className="detail-table">
                            <thead>
                              <tr>
                                <th>{mode === 'campaign' ? 'Campaign' : 'Country'}</th>
                                {mode === 'campaign' && <th>Offer</th>}
                                {mode === 'campaign' ? <th>Geo</th> : <th className="num">Campaigns</th>}
                                <th className="num">Clicks</th>
                                <th className="num">RPC</th>
                                <th className="num">Revenue</th>
                              </tr>
                            </thead>
                            <tbody>
                              {mode === 'campaign' ? r.campaigns.map((c) => (
                                <tr key={c.id}>
                                  <td>
                                    {c.name}
                                    <div className="muted mono" style={{ fontSize: 11 }}>
                                      {c.id}{c.status ? ` · ${c.status}` : ''}
                                    </div>
                                  </td>
                                  <td>{c.offer || dash}</td>
                                  <td><Flag code={c.country} name={c.countryName} /></td>
                                  <td className="num">{int(c.clicks)}</td>
                                  <td className="num">{c.rpc == null ? dash : money(c.rpc)}</td>
                                  <td className="num">{money(c.revenue)}</td>
                                </tr>
                              )) : byCountry(r).map((c) => (
                                <tr key={c.code}>
                                  <td><Flag code={c.code} name={c.name} /> {c.name || c.code}</td>
                                  <td className="num">{c.campaigns}</td>
                                  <td className="num">{int(c.clicks)}</td>
                                  <td className="num">{c.rpc == null ? dash : money(c.rpc)}</td>
                                  <td className="num">{money(c.revenue)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>

              {t && (
                <tfoot>
                  <tr className="summary-row">
                    <td />
                    <td className="label">This page</td>
                    <td colSpan={3} className="muted">
                      {t.keywords} keyword{t.keywords === 1 ? '' : 's'}
                    </td>
                    <td className="num">{int(t.clicks)}</td>
                    <td className="num">{t.rpc == null ? dash : money(t.rpc)}</td>
                    <td className="num">{money(t.revenue)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}

        <div className="card-foot">
          <div className="toolbar">
            <span className="muted" style={{ fontSize: 12 }}>Rows per page</span>
            <select
              value={limit}
              onChange={(e) => { setOffset(0); setLimit(Number(e.target.value)); }}
              style={{ width: 'auto' }}
              aria-label="Rows per page"
            >
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>

          <div className="toolbar">
            <span className="muted" style={{ fontSize: 12 }}>
              {rows.length === 0
                ? 'No rows'
                : `${offset + 1}–${offset + rows.length}`}
            </span>
            <button
              className="btn btn-ghost"
              onClick={() => setOffset((o) => Math.max(0, o - limit))}
              disabled={offset === 0 || loading}
            >
              Previous
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => setOffset((o) => o + limit)}
              /* A short page is the last page — v4 does not always return a
                 total, so a full page is the only honest "there may be more". */
              disabled={!hasMore || loading}
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {(data?.notes || []).length > 0 && (
        <div className="footnotes">
          {data.notes.map((note, i) => <p className="note" key={i}>{note}</p>)}
        </div>
      )}
    </Layout>
  );
}
