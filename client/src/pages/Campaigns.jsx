import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Layout from '../components/Layout.jsx';
import Drawer from '../components/Drawer.jsx';
import SearchBox from '../components/SearchBox.jsx';
import { useToast } from '../components/Toast.jsx';
import { api } from '../lib/api.js';
import { languageName } from '../lib/languages.js';

const STATES = ['active', 'pending', 'stopped', 'deleted'];
const GROUPS = [
  { key: 'campaign', label: 'Campaign' },
  { key: 'day', label: 'Day' },
  { key: 'month', label: 'Month' },
];

/**
 * Ranges are resolved against Tonic's server day (PST/PDT), which the API
 * reports back as `today`. Using the browser's date would show the wrong day
 * for anyone outside California.
 */
const RANGES = {
  today: { label: 'Today', from: (t) => t, to: (t) => t },
  yesterday: { label: 'Yesterday', from: (t) => shift(t, -1), to: (t) => shift(t, -1) },
  last7: { label: 'Last 7 days', from: (t) => shift(t, -6), to: (t) => t },
  last30: { label: 'Last 30 days', from: (t) => shift(t, -29), to: (t) => t },
  thisMonth: { label: 'This month', from: (t) => `${t.slice(0, 7)}-01`, to: (t) => t },
  lastMonth: {
    label: 'Last month',
    from: (t) => `${shift(`${t.slice(0, 7)}-01`, -1).slice(0, 7)}-01`,
    to: (t) => shift(`${t.slice(0, 7)}-01`, -1),
  },
  custom: { label: 'Custom range…', custom: true },
};

/**
 * v4 caps how much can be asked for in one request, and the cap depends on how
 * the result is grouped. Enforced here so a bad range is caught before the
 * round trip, with the same numbers the server would report.
 */
const MAX_DAYS = { campaign: 31, day: 31, month: 186 };

const daysBetween = (from, to) =>
  Math.round((new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / 86_400_000) + 1;

function shift(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const money = (n) => `${Number(n || 0).toFixed(2)} $`;
const pct = (n) => `${Number(n || 0).toFixed(1)} %`;
const int = (n) => Number(n || 0).toLocaleString();

const stateTone = (s) => ({ active: 'badge-ok', stopped: 'badge-bad', deleted: 'badge-idle' }[s] || 'badge-pending');

export default function Campaigns() {
  const toast = useToast();

  const [selectedStates, setSelectedStates] = useState(['active', 'pending']);
  const [rangeKey, setRangeKey] = useState('today');
  // Only used when rangeKey === 'custom'; empty until Tonic's today is known.
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [today, setToday] = useState('');
  const [group, setGroup] = useState('campaign');
  const [search, setSearch] = useState('');

  const [campaigns, setCampaigns] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [needsCredentials, setNeedsCredentials] = useState(false);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [headlines, setHeadlines] = useState([]);
  const [selectedHeadline, setSelectedHeadline] = useState(null);
  const [name, setName] = useState('');
  const [errors, setErrors] = useState({});
  const [launching, setLaunching] = useState(false);

  /**
   * All digits is an ID, anything else is a name. v4 has separate filters for
   * each, so guess from the input rather than making the user choose.
   */
  const searchFilter = (q) => {
    const trimmed = (q || '').trim();
    if (!trimmed) return {};
    return /^[\d,\s]+$/.test(trimmed)
      ? { campaignIds: trimmed.replace(/\s/g, '') }
      : { campaignName: trimmed };
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Resolve the range against Tonic's server day before fetching anything
      // heavy — /stats/today makes no API call of its own.
      const { today: serverToday } = await api.stats.today();
      setToday(serverToday);

      const range = RANGES[rangeKey];
      let from;
      let to;
      if (range.custom) {
        // Nothing to fetch until both ends are set.
        if (!customFrom || !customTo) { setLoading(false); return; }
        from = customFrom;
        to = customTo;
      } else {
        from = range.from(serverToday);
        to = range.to(serverToday);
      }

      if (from > to) { toast.error('The start date is after the end date.'); setLoading(false); return; }
      const cap = MAX_DAYS[group] ?? 31;
      const span = daysBetween(from, to);
      if (span > cap) {
        toast.error(`Tonic allows at most ${cap} days for this view. That range is ${span} days.`);
        setLoading(false);
        return;
      }

      // v4 takes a comma-separated state list and returns stats on each row,
      // so this is one request where v3 needed one per state plus two reports.
      const [statsResult, listResult] = await Promise.all([
        api.stats.get({ from, to, group }),
        group === 'campaign'
          ? api.campaigns.list(selectedStates.join(','), { stats: 'true', from, to, ...searchFilter(search) })
          : Promise.resolve({ rows: [] }),
      ]);

      setStats(statsResult);
      setCampaigns((listResult.rows || []).map((c) => ({ ...c, state: c.status })));
      setNeedsCredentials(false);
      statsResult.notes?.forEach((note) => toast.info(note));
    } catch (err) {
      if (err.code === 'NO_CREDENTIALS') setNeedsCredentials(true);
      else toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [selectedStates, rangeKey, group, search, customFrom, customTo]);

  useEffect(() => { load(); }, [load]);

  /** Default a custom range to the last 7 days so it is never empty on open. */
  const chooseRange = (key) => {
    if (key === 'custom' && today && (!customFrom || !customTo)) {
      setCustomFrom(shift(today, -6));
      setCustomTo(today);
    }
    setRangeKey(key);
  };

  const toggleState = (state) => {
    setSelectedStates((current) =>
      current.includes(state)
        ? current.filter((s) => s !== state) || []
        : [...current, state]
    );
  };

  /** Metrics now arrive on the campaign row itself — no join needed. */
  const campaignRows = useMemo(() => {
    const zero = { views: 0, clicks: 0, vtc: 0, rpc: 0, rpmv: 0, revenue: 0 };
    return campaigns
      .map((c) => ({ ...c, metrics: c.stats || zero }))
      .sort((a, b) => b.metrics.revenue - a.metrics.revenue || String(b.id).localeCompare(String(a.id)));
  }, [campaigns]);

  const openDrawer = async () => {
    setSelectedHeadline(null);
    setName('');
    setErrors({});
    setDrawerOpen(true);
    try {
      setHeadlines(await api.lookups.headlines());
    } catch (err) {
      toast.error(`Could not load articles: ${err.message}`);
    }
  };

  const launch = async () => {
    const next = {};
    if (!name.trim()) next.name = 'Give the campaign a name.';
    if (!selectedHeadline) next.headlineId = 'Choose a published article.';
    setErrors(next);
    if (Object.keys(next).length) return;

    setLaunching(true);
    try {
      // v4 derives the offer and country from the article itself.
      const created = await api.campaigns.create({
        name: name.trim(),
        articleId: selectedHeadline.articleId ?? selectedHeadline.headline_id,
      });
      setDrawerOpen(false);
      toast.success(
        created.tonic_campaign_id
          ? `Campaign ${created.name} created (id ${created.tonic_campaign_id}).`
          : `Campaign created. ${created.note || ''}`
      );
      if (!selectedStates.includes('pending')) setSelectedStates((s) => [...s, 'pending']);
      else load();
    } catch (err) {
      if (err.fields) setErrors(err.fields);
      toast.error(err.message);
    } finally {
      setLaunching(false);
    }
  };

  const metricCells = (m) => (
    <>
      <td className="num">{int(m.views)}</td>
      <td className="num">{int(m.clicks)}</td>
      <td className="num">{pct(m.vtc)}</td>
      <td className="num">{money(m.rpc)}</td>
      <td className="num">{money(m.rpmv)}</td>
      <td className="num">{money(m.revenue)}</td>
    </>
  );

  const METRIC_HEADS = (
    <>
      <th className="num">Views</th>
      <th className="num">Clicks</th>
      <th className="num">VTC</th>
      <th className="num">RPC</th>
      <th className="num">RPMV</th>
      <th className="num">Revenue</th>
    </>
  );

  const summaryRows = (span) => stats && (
    <>
      <tr className="summary-row">
        <td className="label" colSpan={span}>Total</td>
        {metricCells(stats.totals)}
      </tr>
      <tr className="summary-row">
        <td className="label" colSpan={span}>Average</td>
        <td className="num">{int(stats.averages.views)}</td>
        <td className="num">{int(stats.averages.clicks)}</td>
        <td className="num" />
        <td className="num" />
        <td className="num" />
        <td className="num">{money(stats.averages.revenue)}</td>
      </tr>
    </>
  );

  return (
    <Layout
      title="Campaigns"
      actions={<button className="btn" onClick={openDrawer} disabled={needsCredentials}>Create Campaign</button>}
    >
      {needsCredentials && (
        <div className="banner banner-warn">
          <span>⚠</span>
          <div>No Tonic credentials yet. Add them on the <Link to="/settings">Settings</Link> screen.</div>
        </div>
      )}

      <div className="card">
        <div className="tabs">
          <button className="active">Overview</button>
        </div>

        <div className="card-head" style={{ flexWrap: 'wrap' }}>
          <div className="toolbar">
            {STATES.map((s) => (
              <button
                key={s}
                className={`chip ${selectedStates.includes(s) ? 'on' : ''}`}
                onClick={() => toggleState(s)}
                disabled={group !== 'campaign'}
                title={group !== 'campaign' ? 'Status filters apply to the campaign view' : undefined}
              >
                {s}
              </button>
            ))}
            <span style={{ width: 1, height: 24, background: 'var(--line)', margin: '0 4px' }} />
            <select
              value={rangeKey}
              onChange={(e) => chooseRange(e.target.value)}
              style={{ width: 'auto', minWidth: 150 }}
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
                  onChange={(e) => setCustomFrom(e.target.value)}
                  style={{ width: 'auto' }}
                  aria-label="Start date"
                />
                <span className="muted" style={{ fontSize: 12 }}>to</span>
                <input
                  type="date"
                  value={customTo}
                  min={customFrom || undefined}
                  // Tonic has no data for days it has not reached yet.
                  max={today || undefined}
                  onChange={(e) => setCustomTo(e.target.value)}
                  style={{ width: 'auto' }}
                  aria-label="End date"
                />
              </div>
            )}
            <SearchBox
              value={search}
              onSearch={setSearch}
              placeholder="Search by campaign name or ID"
              hint={group !== 'campaign' ? 'Search applies to the campaign view' : null}
              width={260}
            />
          </div>

          <div className="toolbar">
            <div className="seg">
              {GROUPS.map((g) => (
                <button
                  key={g.key}
                  className={group === g.key ? 'on' : ''}
                  onClick={() => setGroup(g.key)}
                >
                  {g.label}
                </button>
              ))}
            </div>
            <button className="btn btn-secondary" onClick={load} disabled={loading}>
              {loading && <span className="spinner" />}
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="empty">Loading…</div>
        ) : group === 'campaign' ? (
          campaignRows.length === 0 ? (
            <div className="empty">
              <p>{search
                ? `No campaigns match “${search}” in the selected states.`
                : 'No campaigns in the selected states.'}</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Id</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Vertical</th>
                  <th>Offer</th>
                  <th>Geo</th>
                  <th>Link</th>
                  {METRIC_HEADS}
                </tr>
              </thead>
              <tbody>
                {campaignRows.map((c) => (
                  <tr key={`${c.state}-${c.id}`}>
                    <td><span className={`badge ${stateTone(c.state)}`}>{c.state}</span></td>
                    <td className="mono">{c.id}</td>
                    <td><Link className="link" to={`/campaigns/${c.id}`}>{c.name}</Link></td>
                    <td>{String(c.type || '').toUpperCase()}</td>
                    <td className="muted">{c.vertical}</td>
                    <td>{c.offer}</td>
                    <td>{c.country}</td>
                    <td>
                      {c.directLink ? (
                        <button
                          className="btn btn-ghost"
                          title={c.directLink}
                          onClick={() => {
                            navigator.clipboard?.writeText(c.directLink)
                              .then(() => toast.success('Direct link copied.'))
                              .catch(() => toast.error('Could not copy.'));
                          }}
                        >
                          Copy
                        </button>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    {metricCells(c.metrics)}
                  </tr>
                ))}
                {summaryRows(8)}
              </tbody>
            </table>
          )
        ) : (
          <table>
            <thead>
              <tr>
                <th>{group === 'day' ? 'Date' : 'Month'}</th>
                {METRIC_HEADS}
              </tr>
            </thead>
            <tbody>
              {(stats?.rows || []).length === 0 ? (
                <tr><td colSpan={7} className="empty">No data in this range.</td></tr>
              ) : (
                stats.rows.map((r) => (
                  <tr key={r.key}>
                    <td className="mono">{r.key}</td>
                    {metricCells(r)}
                  </tr>
                ))
              )}
              {summaryRows(1)}
            </tbody>
          </table>
        )}
      </div>

      {stats && (
        <p className="hint" style={{ marginTop: 12 }}>
          {stats.from === stats.to ? stats.from : `${stats.from} to ${stats.to}`}
          {' '}({daysBetween(stats.from, stats.to)} day{daysBetween(stats.from, stats.to) === 1 ? '' : 's'},
          {' '}max {MAX_DAYS[group] ?? 31} for this view), in Tonic's server timezone (PST/PDT).
          Revenue before the last finalised day is still an estimate, and Tonic reports RPC as 0
          until a campaign passes 10 clicks.
        </p>
      )}

      <Drawer
        title="Create campaign"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setDrawerOpen(false)}>Cancel</button>
            <button className="btn" onClick={launch} disabled={launching}>
              {launching && <span className="spinner" />}
              {launching ? 'Creating…' : 'Create campaign'}
            </button>
          </>
        }
      >
        <div className="field">
          <label htmlFor="headline">Published article</label>
          <p className="hint">
            Only articles Tonic has published appear here. A request you just submitted shows up
            once it moves from pending to published.
          </p>
          <select
            id="headline"
            className={errors.headlineId ? 'invalid' : ''}
            value={selectedHeadline?.articleId ?? selectedHeadline?.headline_id ?? ''}
            onChange={(e) => {
              const found = headlines.find((h) => String(h.articleId ?? h.headline_id) === e.target.value);
              setSelectedHeadline(found || null);
              if (found && !name.trim()) {
                setName(`${found.country}_${String(found.language || '').toUpperCase()}_${String(found.offer_name || '').toUpperCase()}`.trim());
              }
            }}
          >
            <option value="">Select an article</option>
            {headlines.map((h) => (
              <option key={h.articleId ?? h.headline_id} value={h.articleId ?? h.headline_id}>
                {h.headline} — {h.country} / {languageName(h.language)}
              </option>
            ))}
          </select>
          {errors.headlineId && <p className="error-text">{errors.headlineId}</p>}
        </div>

        {selectedHeadline && (
          <div className="summary">
            <dl>
              <dt>Article ID</dt>
              <dd className="mono">{selectedHeadline.articleId ?? selectedHeadline.headline_id}</dd>
              <dt>Offer</dt>
              <dd>{selectedHeadline.offer_name} <span className="muted">(id {selectedHeadline.offer_id})</span></dd>
              <dt>Vertical</dt>
              <dd>{selectedHeadline.vertical_name || '—'}</dd>
              <dt>Country</dt>
              <dd>{selectedHeadline.country}</dd>
              <dt>Language</dt>
              <dd>{languageName(selectedHeadline.language)}</dd>
            </dl>
          </div>
        )}

        <div className="field">
          <label htmlFor="name">Campaign name</label>
          <p className="hint">Must be unique across your Tonic account.</p>
          <input
            id="name"
            type="text"
            className={errors.name ? 'invalid' : ''}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="US_EN_USED_CARS"
          />
          {errors.name && <p className="error-text">{errors.name}</p>}
        </div>
      </Drawer>
    </Layout>
  );
}
