import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import Layout from '../components/Layout.jsx';
import { useToast } from '../components/Toast.jsx';
import { api } from '../lib/api.js';

/**
 * One adset, day by day. Opened in a new tab from the Final Data table, so the
 * range travels in the URL — the tab is then a real, shareable address rather
 * than a view that only exists if you clicked your way to it.
 */
const COLUMNS = [
  { key: 'date',        label: 'Date' },
  { key: 'spend',       label: 'Spend',   money: true },
  { key: 'revenue',     label: 'Revenue', money: true },
  { key: 'profit',      label: 'Profit',  money: true, tone: true },
  { key: 'roi',         label: 'ROI',     pct: true,   tone: true },
  { key: 'cpl',         label: 'CPL',     money: true, title: 'Spend ÷ conversions' },
  { key: 'rpc',         label: 'RPC',     money: true, title: 'Revenue ÷ conversions' },
  { key: 'leads',       label: 'Leads',   int: true },
  { key: 'conversions', label: 'Conv.',   int: true,   title: 'Tonic session clicks' },
  { key: 'impressions', label: 'Impr.',   int: true },
  { key: 'clicks',      label: 'Clicks',  int: true },
];

/**
 * The dashboard went live on this date, so there is no history before it. Every
 * range is clamped here, which keeps a "last 30 days" view from opening with
 * three weeks of zeros. Set VITE_DATA_START_DATE at build time to move it; the
 * server applies the same floor from DATA_START_DATE.
 */
const DATA_START = import.meta.env?.VITE_DATA_START_DATE || '2026-10-08';

const startLabel = new Date(`${DATA_START}T12:00:00Z`)
  .toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

const RANGES = {
  all: { label: `Since ${startLabel}`, days: null },
  last7: { label: 'Last 7 days', days: 7 },
  last14: { label: 'Last 14 days', days: 14 },
  last30: { label: 'Last 30 days', days: 30 },
  last50: { label: 'Last 50 days', days: 50 },
};

const money = (n) => `${Number(n || 0).toFixed(2)} $`;
const int = (n) => Number(n || 0).toLocaleString();
const dash = <span className="muted">—</span>;
const tone = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

function shift(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Render one cell the way its column says to. */
function cell(col, row) {
  const v = row[col.key];
  if (col.key === 'date') {
    return (
      <>
        {v}
        {/* A day Tonic has not finalised can still move, which matters when
            you are reading a trend off these numbers. */}
        {row.final === false && <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>est.</span>}
      </>
    );
  }
  if (v == null) return dash;
  if (col.money) return money(v);
  if (col.pct) return `${v} %`;
  if (col.int) return int(v);
  return v;
}

export default function AdsetHistory() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const toast = useToast();

  const [rangeKey, setRangeKey] = useState(params.get('range') || 'all');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const range = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const days = RANGES[rangeKey]?.days ?? null;
    const from = days ? shift(today, -(days - 1)) : DATA_START;
    // Never ask for days that predate the dashboard.
    return { from: from < DATA_START ? DATA_START : from, to: today };
  }, [rangeKey]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.finalData.adsetHistory(id, { ...range, account: params.get('account') || undefined }));
    } catch (err) {
      toast.error(err.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [id, range]);

  useEffect(() => { load(); }, [load]);

  // The tab's title is how you tell several of these apart.
  useEffect(() => {
    const name = data?.adset?.name;
    document.title = name ? `${name} — Tonic Launcher` : `Adset ${id}`;
  }, [data, id]);

  const t = data?.totals;

  return (
    <Layout
      title={data?.adset?.name || `Adset ${id}`}
      tools={
        <select
          className="topbar-select"
          value={rangeKey}
          onChange={(e) => setRangeKey(e.target.value)}
          aria-label="Date range"
        >
          {Object.entries(RANGES).map(([k, r]) => <option key={k} value={k}>{r.label}</option>)}
        </select>
      }
      actions={
        <button className="btn btn-secondary" onClick={load} disabled={loading}>
          {loading && <span className="spinner" />}
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      }
    >
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head" style={{ flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div className="muted mono" style={{ fontSize: 12 }}>{id}</div>
            {data?.adset?.status && (
              <span className="badge badge-idle" style={{ marginTop: 4 }}>
                {String(data.adset.status).toLowerCase().replace(/_/g, ' ')}
              </span>
            )}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {data?.meta && <>{data.meta.from} to {data.meta.to}</>}
            {data?.adset?.budget != null && <> · budget {money(data.adset.budget)}/day</>}
          </div>
          <Link className="link" to="/final-data">← Back to Final Data</Link>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="empty">Loading…</div>
        ) : !data ? (
          <div className="empty"><p>Nothing to show for this adset.</p></div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th key={c.key} className={c.key === 'date' ? undefined : 'num'} title={c.title}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.date}>
                    {COLUMNS.map((c) => (
                      <td
                        key={c.key}
                        className={[c.key === 'date' ? '' : 'num', c.tone ? tone(r[c.key]) : ''].filter(Boolean).join(' ')}
                      >
                        {cell(c, r)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {t && (
                <tfoot>
                  <tr className="summary-row">
                    <td className="label">Total</td>
                    <td className="num">{money(t.spend)}</td>
                    <td className="num">{money(t.revenue)}</td>
                    <td className={`num ${tone(t.profit)}`}>{money(t.profit)}</td>
                    <td className={`num ${tone(t.roi)}`}>{t.roi == null ? dash : `${t.roi} %`}</td>
                    <td className="num">{t.cpl == null ? dash : money(t.cpl)}</td>
                    <td className="num">{t.rpc == null ? dash : money(t.rpc)}</td>
                    <td className="num">{int(t.leads)}</td>
                    <td className="num">{int(t.conversions)}</td>
                    <td className="num">{int(t.impressions)}</td>
                    <td className="num">{int(t.clicks)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>

      {(data?.notes || []).length > 0 && (
        <div className="footnotes">
          {data.notes.map((n, i) => <p className="note" key={i}>{n}</p>)}
        </div>
      )}
    </Layout>
  );
}
