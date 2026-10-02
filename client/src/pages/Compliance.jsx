import { useCallback, useEffect, useState } from 'react';
import Layout from '../components/Layout.jsx';
import Drawer from '../components/Drawer.jsx';
import SearchBox from '../components/SearchBox.jsx';
import { useToast } from '../components/Toast.jsx';
import { api } from '../lib/api.js';

/**
 * Compliance is the one screen built on Tonic's v4 API — v3 has no equivalent,
 * only a push callback. Everything here is read-only apart from the review
 * request, which is the single action Tonic accepts on a declined ad.
 */

const TABS = [
  { key: 'ad-ids', label: 'Ad IDs' },
  { key: 'site-ids', label: 'Site IDs' },
  { key: 'changelog', label: 'Changelog' },
  { key: 'traffic', label: 'Traffic Check' },
  { key: 'parameters', label: 'Missing Parameters' },
];

const PAGE_SIZE = 50;

const money = (n) => `${Number(n || 0).toFixed(2)} $`;
const int = (n) => Number(n || 0).toLocaleString();
const when = (s) => (s ? String(s).replace('T', ' ').slice(0, 19) : '—');

const statusBadge = (s) => {
  const v = String(s || '').toLowerCase();
  if (v === 'allowed') return 'badge-ok';
  if (v === 'declined' || v === 'disallowed' || v === 'critical') return 'badge-bad';
  if (v === 'warning' || v === 'pending') return 'badge-pending';
  return 'badge-idle';
};

/** Shared pager. Tonic returns {total, limit, offset}. */
function Pager({ pagination, offset, onOffset, busy }) {
  const total = pagination?.total ?? null;
  const shownTo = Math.min(offset + PAGE_SIZE, total ?? offset + PAGE_SIZE);
  return (
    <div className="card-head" style={{ borderBottom: 'none', borderTop: '1px solid var(--line)' }}>
      <span className="muted" style={{ fontSize: 12 }}>
        {total != null ? `${offset + 1}–${shownTo} of ${int(total)}` : ''}
      </span>
      <div className="toolbar">
        <button className="btn btn-secondary" disabled={busy || offset === 0}
                onClick={() => onOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</button>
        <button className="btn btn-secondary"
                disabled={busy || (total != null && offset + PAGE_SIZE >= total)}
                onClick={() => onOffset(offset + PAGE_SIZE)}>Next</button>
      </div>
    </div>
  );
}


/**
 * One box, several filters underneath. v4 exposes a separate parameter for each
 * identifier, so work out which one the text is rather than making the user
 * pick from a menu — and say which was used, so the guess is never silent.
 *
 * Ad IDs are long (around 18 digits); campaign IDs are short. That length
 * difference is what separates them.
 */
const AD_ID_MIN_DIGITS = 12;

function complianceFilter(tab, raw, siteScope) {
  const q = (raw || '').trim();
  if (!q) return { params: {}, matched: null };

  const digitsOnly = /^[\d,\s]+$/.test(q);
  const ids = q.replace(/\s/g, '');
  const longest = Math.max(...ids.split(',').map((p) => p.length));

  if (tab === 'ad-ids') {
    if (digitsOnly && longest >= AD_ID_MIN_DIGITS) return { params: { adIds: ids }, matched: 'Ad ID' };
    if (digitsOnly) return { params: { campaignIds: ids }, matched: 'campaign ID' };
    return { params: { campaignName: q }, matched: 'campaign name' };
  }
  if (tab === 'changelog') {
    if (digitsOnly && longest >= AD_ID_MIN_DIGITS) return { params: { adId: ids }, matched: 'Ad ID' };
    if (digitsOnly) return { params: { campaignId: ids }, matched: 'campaign ID' };
    return { params: { campaignName: q }, matched: 'campaign name' };
  }
  if (tab === 'site-ids') {
    // Only the detected list can be filtered; the enforced one takes no query.
    if (siteScope !== 'detected') return { params: {}, matched: null };
    return digitsOnly
      ? { params: { siteId: ids }, matched: 'site ID' }
      : { params: { site: q }, matched: 'site domain' };
  }
  if (tab === 'parameters') {
    return digitsOnly
      ? { params: { campaignId: ids }, matched: 'campaign ID' }
      : { params: { campaignName: q }, matched: 'campaign name' };
  }
  return { params: {}, matched: null };   // traffic check takes no search filter
}

export default function Compliance() {
  const toast = useToast();
  const [tab, setTab] = useState('ad-ids');
  const [rows, setRows] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [needsCredentials, setNeedsCredentials] = useState(false);

  // Ad IDs filters
  const [status, setStatus] = useState('declined');
  const [earningOnly, setEarningOnly] = useState(false);
  const [withReview, setWithReview] = useState(false);
  // Site IDs
  const [siteScope, setSiteScope] = useState('detected');
  // Parameters
  const [paramSeverity, setParamSeverity] = useState('');
  const [search, setSearch] = useState('');

  const [review, setReview] = useState(null);   // the ad being appealed
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const paging = { limit: PAGE_SIZE, offset };
      const { params: searchParams } = complianceFilter(tab, search, siteScope);
      let result;

      if (tab === 'ad-ids') {
        result = await api.compliance.adIds({
          ...paging,
          ...searchParams,
          status,
          // "Immediate action required" in the Tonic UI = still earning while declined.
          ...(earningOnly ? { revenueFrom: 0 } : {}),
          ...(withReview ? { hasReviewRequest: true } : {}),
        });
      } else if (tab === 'site-ids') {
        result = await api.compliance.siteIds({ ...paging, scope: siteScope, ...searchParams });
      } else if (tab === 'changelog') {
        result = await api.compliance.changeLog({ ...paging, ...searchParams });
      } else if (tab === 'traffic') {
        result = await api.compliance.trafficCheck(paging);
      } else {
        result = await api.compliance.parameters({
          ...paging,
          ...searchParams,
          ...(paramSeverity ? { complianceStatus: paramSeverity } : {}),
        });
      }

      setRows(result.rows || []);
      setPagination(result.pagination || null);
      setNeedsCredentials(false);
      result.warnings?.forEach((w) => toast.info(w));
    } catch (err) {
      if (err.code === 'NO_CREDENTIALS') setNeedsCredentials(true);
      else toast.error(err.message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [tab, offset, status, earningOnly, withReview, siteScope, paramSeverity, search]);

  useEffect(() => { load(); }, [load]);

  // Any filter change invalidates the current page.
  const changeTab = (key) => { setTab(key); setOffset(0); setRows([]); setSearch(''); };
  const setFilter = (fn) => { fn(); setOffset(0); };

  const submitReview = async () => {
    setSending(true);
    setFieldErrors({});
    try {
      await api.compliance.reviewRequest({
        campaignId: review.campaignId,
        adId: review.adId,
        message: message.trim(),
      });
      toast.success('Review request sent. Tonic will re-check this ad.');
      setReview(null);
      setMessage('');
      load();
    } catch (err) {
      if (err.fields) setFieldErrors(err.fields);
      toast.error(err.message);
    } finally {
      setSending(false);
    }
  };

  const { matched: searchMatched } = complianceFilter(tab, search, siteScope);
  const siteScopeNote = tab === 'site-ids' && siteScope !== 'detected' && search
    ? 'Search applies to the detected list only'
    : null;

  const empty = (text) => <tr><td colSpan={12}><div className="empty">{text}</div></td></tr>;

  return (
    <Layout title="Compliance">
      {needsCredentials && (
        <div className="banner banner-warn">
          <span>⚠</span>
          <div>No Tonic credentials yet. Add them on the <a href="/settings">Settings</a> screen.</div>
        </div>
      )}

      <div className="card">
        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => changeTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>

        {tab !== 'traffic' && (
          <div className="card-head" style={{ paddingBottom: 10 }}>
            <SearchBox
              value={search}
              onSearch={(v) => { setSearch(v); setOffset(0); }}
              placeholder={{
                'ad-ids': 'Search by Ad ID, campaign ID or campaign name',
                'changelog': 'Search by Ad ID, campaign ID or campaign name',
                'site-ids': 'Search by site ID or site domain',
                'parameters': 'Search by campaign ID or campaign name',
              }[tab]}
              minLength={tab === 'site-ids' ? 2 : 3}
              hint={searchMatched ? `Matching on ${searchMatched}` : null}
              width={380}
            />
            {siteScopeNote && <span className="muted" style={{ fontSize: 12 }}>{siteScopeNote}</span>}
          </div>
        )}

        {/* ── Filters, per tab ── */}
        {tab === 'ad-ids' && (
          <div className="card-head" style={{ flexWrap: 'wrap' }}>
            <div className="toolbar">
              <button className={`chip ${status === 'declined' ? 'on' : ''}`}
                      onClick={() => setFilter(() => setStatus('declined'))}>Disallowed ad</button>
              <button className={`chip ${status === 'allowed' ? 'on' : ''}`}
                      onClick={() => setFilter(() => setStatus('allowed'))}>Allowed ad</button>
              <span style={{ width: 1, height: 22, background: 'var(--line)', margin: '0 4px' }} />
              <label className="muted" style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={earningOnly} style={{ width: 'auto' }}
                       onChange={(e) => setFilter(() => setEarningOnly(e.target.checked))} />
                Immediate action required
                <span className="muted"> (revenue &gt; $0)</span>
              </label>
              <label className="muted" style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={withReview} style={{ width: 'auto' }}
                       onChange={(e) => setFilter(() => setWithReview(e.target.checked))} />
                Ads with review request
              </label>
            </div>
            <button className="btn btn-secondary" onClick={load} disabled={loading}>
              {loading && <span className="spinner" />}{loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        )}

        {tab === 'site-ids' && (
          <div className="card-head">
            <div className="toolbar">
              <button className={`chip ${siteScope === 'detected' ? 'on' : ''}`}
                      onClick={() => setFilter(() => setSiteScope('detected'))}>Detected in your traffic</button>
              <button className={`chip ${siteScope === 'enforced' ? 'on' : ''}`}
                      onClick={() => setFilter(() => setSiteScope('enforced'))}>Blocked network-wide</button>
            </div>
          </div>
        )}

        {tab === 'parameters' && (
          <div className="card-head">
            <div className="toolbar">
              {[['', 'All'], ['critical', 'Critical'], ['warning', 'Warning']].map(([v, label]) => (
                <button key={label} className={`chip ${paramSeverity === v ? 'on' : ''}`}
                        onClick={() => setFilter(() => setParamSeverity(v))}>{label}</button>
              ))}
            </div>
          </div>
        )}

        {/* ── Tables ── */}
        {loading ? (
          <div className="empty">Loading…</div>
        ) : (
          <>
            {tab === 'ad-ids' && (
              <table>
                <thead><tr>
                  <th>Network ID</th><th>Ad ID</th><th>Campaign</th><th>Network</th>
                  <th>Status</th><th>Explanation</th><th className="num">Revenue</th>
                  <th>Last checked</th><th />
                </tr></thead>
                <tbody>
                  {rows.length === 0 ? empty(search ? `No ${status} ads match “${search}”.` : `No ${status} ads.`) : rows.map((r) => (
                    <tr key={`${r.adId}-${r.campaignId}`}>
                      <td className="mono">{r.networkId || '—'}</td>
                      <td className="mono">
                        {r.adLibraryLink
                          ? <a className="link" href={r.adLibraryLink} target="_blank" rel="noreferrer">{r.adId}</a>
                          : r.adId}
                      </td>
                      <td>
                        {r.campaignName || <span className="muted">—</span>}
                        <div className="muted mono" style={{ fontSize: 11 }}>{r.campaignId}</div>
                      </td>
                      <td style={{ textTransform: 'capitalize' }}>{r.network}</td>
                      <td>
                        <span className={`badge ${statusBadge(r.status)}`}>{r.status}</span>
                        {r.reviewRequest && (
                          <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                            review: {r.reviewRequest.status}
                          </div>
                        )}
                      </td>
                      <td style={{ maxWidth: 340, fontSize: 12 }}>{r.adIdAlignment || '—'}</td>
                      <td className="num">{money(r.revenue)}</td>
                      <td className="muted" style={{ fontSize: 12 }}>{when(r.lastCheck)}</td>
                      <td>
                        {String(r.status).toLowerCase() === 'declined' && !r.reviewRequest && (
                          <button className="btn btn-ghost"
                                  onClick={() => { setReview(r); setMessage(''); setFieldErrors({}); }}>
                            Request review
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {tab === 'site-ids' && (
              <table>
                <thead><tr>
                  <th>Site ID</th><th>Site</th><th>Network</th>
                  {siteScope === 'detected'
                    ? <><th>Detected on</th><th className="num">Views</th><th className="num">Clicks</th><th className="num">Campaigns</th></>
                    : <th>Enforced from</th>}
                </tr></thead>
                <tbody>
                  {rows.length === 0 ? empty(search ? `No site IDs match “${search}”.` : 'No non-compliant site IDs.') : rows.map((r) => (
                    <tr key={`${r.network}-${r.siteId}`}>
                      <td className="mono">{r.siteId}</td>
                      <td>{r.site}</td>
                      <td style={{ textTransform: 'capitalize' }}>{r.network}</td>
                      {siteScope === 'detected' ? (
                        <>
                          <td className="muted">{r.detectedOn}</td>
                          <td className="num">{int(r.views)}</td>
                          <td className="num">{int(r.clicks)}</td>
                          <td className="num">{int(r.campaignsCount)}</td>
                        </>
                      ) : (
                        <td className="muted">{r.enforcedFrom}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {tab === 'changelog' && (
              <table>
                <thead><tr>
                  <th>Checked at</th><th>Ad ID</th><th>Previous</th><th>New</th>
                  <th>Change</th><th>Campaign</th><th>Network</th>
                </tr></thead>
                <tbody>
                  {rows.length === 0
                    ? empty(search
                        ? `No status changes match “${search}” in the last 3 days.`
                        : 'No status changes. Tonic caps this log at a 3-day range.')
                    : rows.map((r, i) => (
                      <tr key={`${r.adId}-${r.checkedAt}-${i}`}>
                        <td className="muted" style={{ fontSize: 12 }}>{when(r.checkedAt)}</td>
                        <td className="mono">{r.adId}</td>
                        <td><span className={`badge ${statusBadge(r.prevStatus)}`}>{r.prevStatus}</span></td>
                        <td><span className={`badge ${statusBadge(r.newStatus)}`}>{r.newStatus}</span></td>
                        <td className="muted">{r.changeType}</td>
                        <td>
                          {r.campaignName}
                          <div className="muted mono" style={{ fontSize: 11 }}>{r.campaignId}</div>
                        </td>
                        <td style={{ textTransform: 'capitalize' }}>{r.network}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}

            {tab === 'traffic' && (
              <table>
                <thead><tr>
                  <th>Campaign ID</th><th>Campaign</th><th>Network</th>
                  <th className="num">Network clicks</th><th className="num">Redirects</th><th className="num">Deviation</th>
                </tr></thead>
                <tbody>
                  {rows.length === 0
                    ? empty('No issues detected. All campaigns are within normal traffic parameters.')
                    : rows.map((r) => (
                      <tr key={r.campaignId}>
                        <td className="mono">{r.campaignId}</td>
                        <td>{r.campaignName}</td>
                        <td style={{ textTransform: 'capitalize' }}>{r.network}</td>
                        <td className="num">{int(r.networkClickCount)}</td>
                        <td className="num">{int(r.redirectCount)}</td>
                        <td className="num">
                          {r.deviation == null ? (
                            <span className="muted">—</span>
                          ) : (
                            // Fewer redirects than clicks is the direction that costs money.
                            <span style={{ color: r.deviation <= -10 ? 'var(--bad-ink)' : 'inherit',
                                           fontWeight: r.deviation <= -10 ? 600 : 400 }}>
                              {r.deviation > 0 ? '+' : ''}{r.deviation} %
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}

            {tab === 'parameters' && (
              <table>
                <thead><tr>
                  <th>Campaign ID</th><th>Campaign</th><th>Campaign status</th>
                  <th>Type</th><th>Compliance</th><th>Parameters</th>
                </tr></thead>
                <tbody>
                  {rows.length === 0
                    ? empty(search
                        ? `No campaigns match “${search}”.`
                        : 'No campaigns are missing required parameters.')
                    : rows.map((r) => (
                      <tr key={r.campaignId}>
                        <td className="mono">{r.campaignId}</td>
                        <td>{r.campaignName}</td>
                        <td className="muted" style={{ textTransform: 'capitalize' }}>{r.campaignStatus}</td>
                        <td>{String(r.campaignType || '').toUpperCase()}</td>
                        <td><span className={`badge ${statusBadge(r.complianceStatus)}`}>{r.complianceStatus}</span></td>
                        <td>
                          {r.parameters && typeof r.parameters === 'object'
                            ? Object.entries(r.parameters).map(([name, info]) => (
                                <div key={name} style={{ fontSize: 12, marginBottom: 2 }}>
                                  <span className="mono">{name}</span>
                                  <span className="muted">
                                    {' — '}{info?.status ?? String(info)}
                                    {info?.missingDays ? ` for ${info.missingDays} day${info.missingDays === 1 ? '' : 's'}` : ''}
                                  </span>
                                </div>
                              ))
                            : <span className="muted">—</span>}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}

            <Pager pagination={pagination} offset={offset} onOffset={setOffset} busy={loading} />
          </>
        )}
      </div>

      <Drawer
        title="Request review"
        open={Boolean(review)}
        onClose={() => setReview(null)}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setReview(null)}>Cancel</button>
            <button className="btn" onClick={submitReview} disabled={sending}>
              {sending && <span className="spinner" />}{sending ? 'Sending…' : 'Send request'}
            </button>
          </>
        }
      >
        {review && (
          <>
            <div className="summary">
              <dl>
                <dt>Ad ID</dt><dd className="mono">{review.adId}</dd>
                <dt>Campaign</dt><dd>{review.campaignName} <span className="muted">({review.campaignId})</span></dd>
                <dt>Network</dt><dd style={{ textTransform: 'capitalize' }}>{review.network}</dd>
                <dt>Revenue</dt><dd>{money(review.revenue)}</dd>
                <dt>Tonic's reason</dt><dd>{review.adIdAlignment || '—'}</dd>
              </dl>
            </div>

            <div className="field">
              <label htmlFor="msg">Why should this be reconsidered?</label>
              <p className="hint">
                A person at Tonic reads this. Address the specific reason above rather than asking
                generally — between 10 and 500 characters.
              </p>
              <textarea
                id="msg"
                className={fieldErrors.message ? 'invalid' : ''}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                style={{ minHeight: 130 }}
              />
              <p className="counter">{message.trim().length} / 500</p>
              {fieldErrors.message && <p className="error-text">{fieldErrors.message}</p>}
            </div>
          </>
        )}
      </Drawer>
    </Layout>
  );
}
