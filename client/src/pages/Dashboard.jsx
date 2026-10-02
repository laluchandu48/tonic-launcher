import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Layout from '../components/Layout.jsx';
import { useToast } from '../components/Toast.jsx';
import { ColumnChart, RankedBars } from '../components/Charts.jsx';
import { api } from '../lib/api.js';

const money = (n, compact) => {
  const v = Number(n || 0);
  if (compact) return v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`;
  return `$ ${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const count = (n, compact) => {
  const v = Number(n || 0);
  if (compact) return v >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v));
  return v.toLocaleString();
};
const pct = (n) => `${Number(n || 0).toFixed(1)}%`;

function shift(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default function Dashboard() {
  const toast = useToast();

  const [settings, setSettings] = useState(null);
  const [requests, setRequests] = useState([]);
  const [launched, setLaunched] = useState([]);

  const [summary, setSummary] = useState(null);
  const [daily, setDaily] = useState(null);
  const [offers, setOffers] = useState(null);
  const [loadingStats, setLoadingStats] = useState(true);
  const [calculating, setCalculating] = useState(false);

  useEffect(() => {
    api.settings.get().then(setSettings).catch(() => {});
    api.articles.list().then((r) => setRequests(r.rows || [])).catch(() => {});
    api.campaigns.launched().then(setLaunched).catch(() => {});

    (async () => {
      try {
        const { today } = await api.stats.today();
        const from = shift(today, -6);
        const [sum, day, off] = await Promise.all([
          api.stats.summary(),
          api.stats.get({ from, to: today, group: 'day' }),
          api.stats.offers({ from, to: today, limit: 5 }),
        ]);
        setSummary(sum);
        setDaily(day);
        setOffers(off);
        day.notes?.forEach((n) => toast.info(n));
      } catch (err) {
        if (err.code !== 'NO_CREDENTIALS') toast.error(err.message);
      } finally {
        setLoadingStats(false);
      }
    })();
  }, []);

  const calculateAllTime = async () => {
    setCalculating(true);
    toast.info('Fetching month by month — this takes a moment the first time.');
    try {
      const result = await api.stats.refreshAllTime();
      setSummary((s) => ({ ...s, allTime: { ...result.allTime, stale: false } }));
      toast.success(
        `All-time revenue calculated from ${result.fetched} month${result.fetched === 1 ? '' : 's'}.`
        + (result.failures.length ? ` ${result.failures.length} failed.` : '')
      );
    } catch (err) {
      toast.error(err.message);
    } finally {
      setCalculating(false);
    }
  };

  const byStatus = (status) =>
    requests.filter((r) => String(r.status).toLowerCase() === status).length;

  // Oldest first so the charts read left to right through time.
  const series = [...(daily?.rows || [])].sort((a, b) => String(a.key).localeCompare(String(b.key)));

  return (
    <Layout title="Dashboard">
      {settings && !settings.configured && (
        <div className="banner banner-warn">
          <span>⚠</span>
          <div>
            Tonic credentials are not configured yet. Add them on the{' '}
            <Link to="/settings">Settings</Link> screen before creating articles or campaigns.
          </div>
        </div>
      )}

      {/* ── Launcher counters ── */}
      <div className="stats">
        <div className="stat">
          <div className="stat-label">Article requests</div>
          <div className="stat-value">{requests.length}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Published</div>
          <div className="stat-value">{byStatus('published')}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Pending</div>
          <div className="stat-value">{byStatus('pending')}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Campaigns launched here</div>
          <div className="stat-value">{launched.length}</div>
        </div>
      </div>

      {/* ── Account headline numbers ── */}
      <div className="stats">
        <div className="stat">
          <div className="stat-label">Last 30 days revenue</div>
          <div className="stat-value">{loadingStats ? '—' : money(summary?.last30Revenue)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Today's conversions</div>
          <div className="stat-value">{loadingStats ? '—' : count(summary?.todayConversions)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">All time revenue</div>
          {summary?.allTime?.stale ? (
            <>
              <div className="stat-value" style={{ fontSize: 17, color: 'var(--ink-soft)' }}>Not calculated</div>
              <button
                className="btn btn-secondary"
                style={{ marginTop: 8 }}
                onClick={calculateAllTime}
                disabled={calculating}
              >
                {calculating && <span className="spinner" />}
                {calculating ? 'Calculating…' : 'Calculate'}
              </button>
            </>
          ) : (
            <>
              <div className="stat-value">{loadingStats ? '—' : money(summary?.allTime?.revenue)}</div>
              {summary?.allTime?.earliest && (
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                  since {summary.allTime.earliest}
                  <button className="btn btn-ghost" style={{ padding: '2px 6px', fontSize: 11 }}
                          onClick={calculateAllTime} disabled={calculating}>
                    refresh
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Charts ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.55fr) minmax(0, 1fr)', gap: 16, marginBottom: 18, alignItems: 'start' }}>
        <div className="card">
          <div className="card-head">
            <h2>Uniques &amp; revenue</h2>
            <span className="muted" style={{ fontSize: 12 }}>Last 7 days</span>
          </div>
          <div className="card-body">
            {loadingStats ? (
              <div className="empty">Loading…</div>
            ) : (
              <>
                <ColumnChart title="Uniques" data={series} labelKey="key" valueKey="views" format={count} />
                <div style={{ height: 18 }} />
                <ColumnChart title="Revenue" data={series} labelKey="key" valueKey="revenue" format={money} />
                <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
                  Shown as two plots rather than one. Putting uniques and revenue on separate y-scales in a
                  single frame would imply a relationship the scales invented.
                </p>
              </>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Top offers</h2>
            <span className="muted" style={{ fontSize: 12 }}>Last 7 days</span>
          </div>
          <div className="card-body">
            {loadingStats ? (
              <div className="empty">Loading…</div>
            ) : (
              <RankedBars data={offers?.offers || []} labelKey="offer" valueKey="revenue" shareKey="share" format={money} />
            )}
          </div>
        </div>
      </div>

      {/* ── Daily stats ── */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-head">
          <h2>Daily stats</h2>
          <span className="muted" style={{ fontSize: 12 }}>
            {daily ? `${daily.from} to ${daily.to}` : ''}
          </span>
        </div>
        {loadingStats ? (
          <div className="empty">Loading…</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th className="num">Uniques</th>
                <th className="num">Conversions</th>
                <th className="num">CTR</th>
                <th className="num">CPC</th>
                <th className="num">RPM</th>
                <th className="num">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {(daily?.rows || []).length === 0 ? (
                <tr><td colSpan={7} className="empty">No data in this range.</td></tr>
              ) : (
                daily.rows.map((r) => (
                  <tr key={r.key}>
                    <td className="mono">{r.key}</td>
                    <td className="num">{count(r.views)}</td>
                    <td className="num">{count(r.clicks)}</td>
                    <td className="num">{pct(r.vtc)}</td>
                    <td className="num">{money(r.rpc)}</td>
                    <td className="num">{money(r.rpmv)}</td>
                    <td className="num">{money(r.revenue)}</td>
                  </tr>
                ))
              )}
              {daily && (
                <>
                  <tr className="summary-row">
                    <td className="label">Total</td>
                    <td className="num">{count(daily.totals.views)}</td>
                    <td className="num">{count(daily.totals.clicks)}</td>
                    <td className="num">{pct(daily.totals.vtc)}</td>
                    <td className="num">{money(daily.totals.rpc)}</td>
                    <td className="num">{money(daily.totals.rpmv)}</td>
                    <td className="num">{money(daily.totals.revenue)}</td>
                  </tr>
                  <tr className="summary-row">
                    <td className="label">Average</td>
                    <td className="num">{count(daily.averages.views)}</td>
                    <td className="num">{count(daily.averages.clicks)}</td>
                    <td className="num" />
                    <td className="num" />
                    <td className="num" />
                    <td className="num">{money(daily.averages.revenue)}</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Flow, now at the bottom ── */}
      <div className="card">
        <div className="card-head"><h2>How the flow works</h2></div>
        <div className="card-body">
          <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 2 }}>
            <li><Link to="/articles">Create an article request</Link> — offer, GEO, language, domain and 3–5 content phrases.</li>
            <li>Tonic reviews and publishes it. The list shows the current status live.</li>
            <li>Once published it carries an <span className="mono">articleId</span>.</li>
            <li><Link to="/campaigns">Create a campaign</Link> against that article to get a direct link.</li>
          </ol>
        </div>
      </div>
    </Layout>
  );
}
