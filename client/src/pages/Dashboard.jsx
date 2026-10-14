import { useCallback, useEffect, useState } from 'react';
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
/** Profit and ROI are the two numbers worth colouring. */
const tone = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

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

  /* Today's Facebook side. Kept in its own request and its own state because
     it can be unavailable (no token, no ad account) while everything else on
     this screen is perfectly fine — one missing panel, not a broken page. */
  const [fbToday, setFbToday] = useState(null);
  const [fbRows, setFbRows] = useState([]);
  const [fbNotes, setFbNotes] = useState([]);
  const [fbFetchedAt, setFbFetchedAt] = useState(null);
  const [fbState, setFbState] = useState('loading'); // loading | ok | none | error
  const [fbRefreshing, setFbRefreshing] = useState(false);
  const [todayIso, setTodayIso] = useState('');

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
        setTodayIso(today);
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

  /**
   * Facebook runs in its own effect, not inside the Tonic one.
   *
   * It is slow by nature — the development access tier allows about one call
   * per 30 seconds and this needs two per account — and when it shared the
   * Tonic effect its `finally` held `loadingStats` true, so the revenue and
   * conversion cards sat on "—" waiting for Facebook. They are separate
   * requests and must fail, and finish, separately.
   */
  const loadAccounts = useCallback(async (refresh = false) => {
    if (!todayIso) return;
    if (refresh) setFbRefreshing(true);
    try {
      /* Which accounts this covers is the selection saved on FB Settings —
         the server reads it, so nothing about it travels in the URL. */
      const fb = await api.finalData.accounts({ from: todayIso, to: todayIso, refresh });
      setFbToday(fb.totals || null);
      setFbRows(fb.rows || []);
      setFbNotes(fb.notes || []);
      setFbFetchedAt(fb.fetchedAt || null);
      setFbState('ok');
    } catch (err) {
      setFbState(err.code === 'NO_FB_CREDENTIALS' ? 'none' : 'error');
      setFbNotes(err.message ? [err.message] : []);
      setFbRows([]);
      setFbToday(null);
      if (refresh) toast.error(err.message);
    } finally {
      setFbRefreshing(false);
    }
  }, [todayIso]);

  useEffect(() => {
    setFbState('loading');
    loadAccounts(false);
  }, [loadAccounts]);

  const refreshAccounts = () => loadAccounts(true);

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

      {/* ── Today, every ad account: spend against the Tonic revenue it matched ── */}
      {fbState !== 'none' && (
        <>
          <div className="stats">
            <div className="stat">
              <div className="stat-label">Today's ad spend</div>
              <div className="stat-value">
                {fbState === 'loading' ? '—' : money(fbToday?.spend)}
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                {fbState === 'ok'
                  ? `${fbToday?.accounts ?? 0} ad account${fbToday?.accounts === 1 ? '' : 's'}`
                  : 'selected ad accounts'}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Today's revenue</div>
              <div className="stat-value">
                {fbState === 'loading' ? '—' : money(fbToday?.revenue)}
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>matched to adsets</div>
            </div>
            <div className="stat">
              <div className="stat-label">Today's profit</div>
              <div className={`stat-value ${fbState === 'ok' ? tone(fbToday?.profit) : ''}`}>
                {fbState === 'loading' ? '—' : money(fbToday?.profit)}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Today's ROI</div>
              <div className={`stat-value ${fbState === 'ok' ? tone(fbToday?.roi) : ''}`}>
                {fbState === 'loading' ? '—'
                  : fbToday?.roi == null ? '—'
                  : `${fbToday.roi} %`}
              </div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 18 }}>
            <div className="card-head" style={{ flexWrap: 'wrap', gap: 10 }}>
              <h2>By ad account</h2>
              <div className="toolbar">
                {fbFetchedAt && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    as of {new Date(fbFetchedAt).toLocaleTimeString()}
                  </span>
                )}
                <Link className="link" to="/final-data">Final Data</Link>
                <button
                  className="btn btn-secondary"
                  onClick={refreshAccounts}
                  disabled={fbRefreshing || fbState === 'loading'}
                  title="Re-fetches every ad account from Facebook — one call at a time, so it takes a moment"
                >
                  {fbRefreshing && <span className="spinner" />}
                  {fbRefreshing ? 'Fetching…' : 'Refresh'}
                </button>
              </div>
            </div>

            {fbState === 'loading' ? (
              <div className="empty">Loading…</div>
            ) : fbRows.length === 0 ? (
              <div className="empty">
                <p>
                  {fbState === 'error'
                    ? 'Facebook returned nothing for this selection.'
                    : 'No ad accounts are reachable with the current Facebook token.'}
                </p>
                <p className="hint">
                  Choose which ad accounts this covers on{' '}
                  <Link className="link" to="/fb-settings">FB Settings</Link>. Picking the few you
                  actually watch also makes this load in seconds — every account costs two Facebook
                  calls, taken one at a time.
                </p>
              </div>
            ) : (
              <div className="table-scroll" style={{ '--table-min': '620px' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Ad account</th>
                      <th className="num">Spend</th>
                      <th className="num">Revenue</th>
                      <th className="num">Profit</th>
                      <th className="num">ROI</th>
                      <th className="num" title="Adsets with Tonic revenue against them, of all adsets with spend">Matched</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fbRows.map((r) => (
                      <tr key={r.accountId}>
                        <td>
                          {r.name}
                          <div className="muted mono" style={{ fontSize: 11 }}>
                            {r.accountId}
                            {r.currency && r.currency !== 'USD' && (
                              <span className="badge badge-pending" style={{ marginLeft: 6 }}>{r.currency}</span>
                            )}
                            {r.active === false && (
                              <span className="badge badge-idle" style={{ marginLeft: 6 }}>inactive</span>
                            )}
                          </div>
                        </td>
                        {r.error ? (
                          /* A row of zeros would read as "spent nothing" rather
                             than "could not be asked", so it says which. */
                          <td className="muted" colSpan={5}>{r.error}</td>
                        ) : (
                          <>
                            <td className="num">{money(r.spend)}</td>
                            <td className="num">{money(r.revenue)}</td>
                            <td className={`num ${tone(r.profit)}`}>{money(r.profit)}</td>
                            <td className={`num ${tone(r.roi)}`}>{r.roi == null ? '—' : `${r.roi} %`}</td>
                            <td className="num muted">{r.matched} / {r.adsets}</td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                  {fbToday && (
                    <tfoot>
                      <tr className="summary-row">
                        <td className="label">Total</td>
                        <td className="num">{money(fbToday.spend)}</td>
                        <td className="num">{money(fbToday.revenue)}</td>
                        <td className={`num ${tone(fbToday.profit)}`}>{money(fbToday.profit)}</td>
                        <td className={`num ${tone(fbToday.roi)}`}>
                          {fbToday.roi == null ? '—' : `${fbToday.roi} %`}
                        </td>
                        <td />
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}

            {fbNotes.length > 0 && (
              <div className="footnotes">
                {fbNotes.map((note, i) => <p className="note" key={i}>{note}</p>)}
              </div>
            )}
          </div>
        </>
      )}

      {fbState === 'error' && (
        <p className="hint" style={{ marginTop: -10, marginBottom: 18 }}>
          Today's Facebook numbers could not be fetched. The rest of this page is
          unaffected — check the token on <Link className="link" to="/fb-settings">FB Settings</Link>.
        </p>
      )}

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
