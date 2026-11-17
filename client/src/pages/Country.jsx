import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Layout from '../components/Layout.jsx';
import SearchBox from '../components/SearchBox.jsx';
import { useToast } from '../components/Toast.jsx';
import {
  useColumnPrefs, ColumnsMenu, HeaderRow, sortRows, nextSort, tableMinWidth,
} from '../components/TableColumns.jsx';
import { api } from '../lib/api.js';

/**
 * Country — which GEOs are paying for themselves.
 *
 * One row per Tonic campaign per country: revenue and conversions from Tonic's
 * session report, spend and leads from Facebook's country breakdown. Both
 * sides are asked for the same range and joined on the adset id in the
 * tracking link, so the numbers are the same ones Final Data shows, cut a
 * different way.
 */

function shift(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const RANGES = {
  today: { label: 'Today', from: (t) => t, to: (t) => t },
  yesterday: { label: 'Yesterday', from: (t) => shift(t, -1), to: (t) => shift(t, -1) },
  last7: { label: 'Last 7 days', from: (t) => shift(t, -6), to: (t) => t },
  last14: { label: 'Last 14 days', from: (t) => shift(t, -13), to: (t) => t },
  last30: { label: 'Last 30 days', from: (t) => shift(t, -29), to: (t) => t },
  thisMonth: { label: 'This month', from: (t) => `${t.slice(0, 7)}-01`, to: (t) => t },
  custom: { label: 'Custom range…', custom: true },
};

const COLUMNS = [
  { key: 'campaignName', label: 'Campaign', width: 280 },
  { key: 'country', label: 'Country', width: 150 },
  { key: 'spend', label: 'Spend', numeric: true },
  { key: 'revenue', label: 'Revenue', numeric: true },
  { key: 'profit', label: 'Profit', numeric: true },
  { key: 'roi', label: 'ROI', numeric: true },
  { key: 'leads', label: 'Leads', numeric: true },
  { key: 'conversions', label: 'Conv.', numeric: true, title: 'Tonic session clicks' },
  { key: 'cpl', label: 'CPL', numeric: true, title: 'Spend per Tonic session click' },
  { key: 'rpc', label: 'RPC', numeric: true, title: 'Revenue per Tonic session click' },
];

const money = (n, code = 'USD') => {
  const amount = Number(n || 0).toFixed(2);
  return `${amount} ${code === 'USD' ? '$' : code}`;
};
const int = (n) => Number(n || 0).toLocaleString();
const dash = <span className="muted">—</span>;
const tone = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

/**
 * A country code as its flag. The regional-indicator trick maps AB to 🇦🇧; the
 * code stays beside it, because a flag nobody recognises is not a label.
 */
function Flag({ code }) {
  if (!code || code.length !== 2 || code === '??') return null;
  const emoji = String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => 127_397 + c.charCodeAt(0))
  );
  return <span aria-hidden="true" style={{ marginRight: 6 }}>{emoji}</span>;
}

export default function Country() {
  const toast = useToast();

  const [rangeKey, setRangeKey] = useState('last7');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [today, setToday] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ key: 'spend', dir: 'desc' });

  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [accountsLoading, setAccountsLoading] = useState(true);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(null); // 'tonic' | 'facebook'

  /** Code → name, so the table can say Germany rather than DE. */
  const [names, setNames] = useState({});

  const { hidden, visible, widths, toggle, setWidth, reset, customised } =
    useColumnPrefs('tonic.country.columns', COLUMNS);

  useEffect(() => {
    api.stats.today()
      .then((r) => setToday(r.today || new Date().toISOString().slice(0, 10)))
      .catch(() => setToday(new Date().toISOString().slice(0, 10)));
  }, []);

  useEffect(() => {
    api.finalData.adAccounts()
      .then(({ accounts: list, selected }) => {
        setAccounts(list);
        setAccountId(selected || list[0]?.id || '');
      })
      .catch((err) => {
        if (err.code === 'NO_FB_CREDENTIALS') setBlocked('facebook');
        else toast.error(`Could not list ad accounts: ${err.message}`);
      })
      .finally(() => setAccountsLoading(false));
  }, []);

  useEffect(() => {
    api.lookups.countries()
      .then((rows) => setNames(Object.fromEntries(rows.map((c) => [c.code, c.name]))))
      .catch(() => { /* codes alone still read fine */ });
  }, []);

  const range = useMemo(() => {
    if (!today) return null;
    const r = RANGES[rangeKey];
    if (r.custom) {
      if (!customFrom || !customTo) return null;
      return { from: customFrom, to: customTo };
    }
    return { from: r.from(today), to: r.to(today) };
  }, [rangeKey, customFrom, customTo, today]);

  const load = useCallback(async () => {
    if (!accountId) {
      if (!accountsLoading) setLoading(false);
      return;
    }
    if (!range) return;
    setLoading(true);
    try {
      setData(await api.country.get({ ...range, account: accountId }));
      setBlocked(null);
    } catch (err) {
      if (err.code === 'NO_CREDENTIALS') setBlocked('tonic');
      else if (err.code === 'NO_FB_CREDENTIALS') setBlocked('facebook');
      else toast.error(err.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [range, accountId, accountsLoading]);

  useEffect(() => { load(); }, [load]);

  const chooseRange = (key) => {
    setRangeKey(key);
    if (key === 'custom' && !customFrom && today) {
      setCustomFrom(shift(today, -6));
      setCustomTo(today);
    }
  };

  const currency = data?.meta?.currency || 'USD';
  const countryLabel = (code) => (code === '??' ? 'Not reported' : names[code] || code);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (data?.rows || []).filter((r) => {
      if (!q) return true;
      return [r.campaignName, r.country, countryLabel(r.country)]
        .some((v) => String(v ?? '').toLowerCase().includes(q));
    });
    /* Sorting the country column by its name rather than its code, since the
       name is what is on screen. */
    const columnsForSort = COLUMNS.map((c) => (
      c.key === 'country' ? { ...c, value: (r) => countryLabel(r.country) } : c
    ));
    return sortRows(list, columnsForSort, sort);
  }, [data, search, sort, names]);

  /** The totals follow what is on screen: a filtered table with the whole
      account's total under it invites the wrong conclusion. */
  const totals = useMemo(() => {
    if (!data) return null;
    if (!search.trim()) return data.totals;
    const sum = (f) => rows.reduce((n, r) => n + (Number(r[f]) || 0), 0);
    const spend = sum('spend');
    const revenue = sum('revenue');
    const conversions = sum('conversions');
    const profit = revenue - spend;
    return {
      spend, revenue, profit,
      roi: spend > 0 ? Math.round((profit / spend) * 1000) / 10 : null,
      leads: sum('leads'),
      conversions,
      cpl: conversions > 0 ? spend / conversions : null,
      rpc: conversions > 0 ? revenue / conversions : null,
      filtered: true,
    };
  }, [data, rows, search]);

  const cell = (col, r) => {
    switch (col.key) {
      case 'campaignName':
        return r.campaignName || (
          <span className="muted" title="Spend in a country with no Tonic session against it">
            No Tonic campaign
          </span>
        );
      case 'country':
        return (
          <>
            <Flag code={r.country} />
            {countryLabel(r.country)}
            {r.country !== '??' && (
              <span className="muted mono" style={{ fontSize: 11, marginLeft: 6 }}>{r.country}</span>
            )}
          </>
        );
      case 'spend':
        return (
          <>
            {money(r.spend, currency)}
            {/* An estimate should not look like a measurement. */}
            {r.estimated && <span className="muted" title="Divided between several Tonic campaigns this adset fed" style={{ marginLeft: 4 }}>≈</span>}
          </>
        );
      case 'revenue': return money(r.revenue, currency);
      case 'profit': return money(r.profit, currency);
      case 'roi': return r.roi == null ? dash : `${r.roi} %`;
      case 'cpl': return r.cpl == null ? dash : money(r.cpl, currency);
      case 'rpc': return r.rpc == null ? dash : money(r.rpc, currency);
      default: return int(r[col.key]);
    }
  };

  const footCell = (col, t) => {
    switch (col.key) {
      case 'campaignName': return null;
      case 'country': return null;
      case 'spend': return money(t.spend, currency);
      case 'revenue': return money(t.revenue, currency);
      case 'profit': return money(t.profit, currency);
      case 'roi': return t.roi == null ? dash : `${t.roi} %`;
      case 'cpl': return t.cpl == null ? dash : money(t.cpl, currency);
      case 'rpc': return t.rpc == null ? dash : money(t.rpc, currency);
      default: return int(t[col.key]);
    }
  };

  const tdClass = (col, row) => [
    col.numeric ? 'num' : '',
    row && (col.key === 'profit' || col.key === 'roi') ? tone(row[col.key]) : '',
  ].filter(Boolean).join(' ') || undefined;

  const labelAt = Math.max(0, visible.findIndex((c) => c.key === 'campaignName'));

  return (
    <Layout
      title="Country"
      tools={(
        <select
          className="topbar-select"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          disabled={accountsLoading || accounts.length === 0}
          aria-label="Ad account"
        >
          {accountsLoading && <option value="">Loading…</option>}
          {!accountsLoading && accounts.length === 0 && <option value="">No ad accounts</option>}
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}{a.currency ? ` (${a.currency})` : ''}{a.active ? '' : ' — inactive'}
            </option>
          ))}
        </select>
      )}
      actions={(
        <button className="btn btn-secondary" onClick={load} disabled={loading}>
          {loading && <span className="spinner" />}
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      )}
    >
      {blocked ? (
        <div className="empty">
          <p>
            {blocked === 'tonic'
              ? <>No Tonic credentials yet. Add them on the <Link to="/settings">Settings</Link> screen.</>
              : <>No Facebook credentials yet. Add an access token and ad account on the <Link to="/fb-settings">FB Settings</Link> screen.</>}
          </p>
        </div>
      ) : (
        <div className="card">
          <div className="card-head" style={{ flexWrap: 'wrap', gap: 10 }}>
            <div className="toolbar">
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
                <>
                  <input
                    type="date"
                    value={customFrom}
                    max={customTo || today}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    style={{ width: 'auto' }}
                    aria-label="From"
                  />
                  <input
                    type="date"
                    value={customTo}
                    min={customFrom}
                    max={today}
                    onChange={(e) => setCustomTo(e.target.value)}
                    style={{ width: 'auto' }}
                    aria-label="To"
                  />
                </>
              )}

              {/* The rows are already here, so this filters rather than
                  re-queries: one character is a useful filter, and waiting
                  400ms for a list that is in memory feels broken. */}
              <SearchBox
                value={search}
                onSearch={setSearch}
                minLength={1}
                delay={120}
                placeholder="Search campaign or country"
              />
            </div>

            <div className="toolbar">
              {data?.meta && (
                <span className="muted" style={{ fontSize: 12 }}>
                  {data.meta.from} to {data.meta.to}
                </span>
              )}
              <ColumnsMenu
                columns={COLUMNS}
                hidden={hidden}
                toggle={toggle}
                reset={reset}
                customised={customised}
              />
            </div>
          </div>

          {loading ? (
            <div className="empty">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="empty">
              <p>
                {search
                  ? `Nothing matches “${search}”.`
                  : 'No spend or revenue in this range for this ad account.'}
              </p>
              {search && (
                <button className="btn btn-ghost" onClick={() => setSearch('')}>Clear search</button>
              )}
            </div>
          ) : (
            <div className="table-scroll" style={{ '--table-min': tableMinWidth(visible, widths) }}>
              <table>
                <thead>
                  <HeaderRow
                    columns={visible}
                    widths={widths}
                    setWidth={setWidth}
                    sort={sort}
                    onSort={(col) => setSort((s) => nextSort(s, col))}
                  />
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.campaignId || 'none'}-${r.country}`}>
                      {visible.map((col) => (
                        <td key={col.key} className={tdClass(col, r)}>{cell(col, r)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                {totals && (
                  <tfoot>
                    <tr className="summary-row">
                      {visible.map((col, i) => (
                        <td key={col.key} className={tdClass(col, totals)}>
                          {i === labelAt
                            ? <span className="label">{totals.filtered ? 'Total (filtered)' : 'Total'}</span>
                            : footCell(col, totals)}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}

          {(data?.notes || []).length > 0 && (
            <div className="footnotes">
              {data.notes.map((note, i) => <p className="note" key={i}>{note}</p>)}
            </div>
          )}
        </div>
      )}
    </Layout>
  );
}
