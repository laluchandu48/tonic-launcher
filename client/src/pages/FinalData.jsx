import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Layout from '../components/Layout.jsx';
import SearchBox from '../components/SearchBox.jsx';
import Switch from '../components/Switch.jsx';
import {
  ColumnsMenu, HeaderRow, nextSort, sortRows, tableMinWidth, useColumnPrefs,
} from '../components/TableColumns.jsx';
import { useToast } from '../components/Toast.jsx';
import { api } from '../lib/api.js';

/**
 * Tonic's session report refuses anything older than 50 days, so nothing here
 * offers a longer window than the data actually reaches.
 */
const RANGES = {
  today: { label: 'Today', from: (t) => t, to: (t) => t },
  yesterday: { label: 'Yesterday', from: (t) => shift(t, -1), to: (t) => shift(t, -1) },
  last7: { label: 'Last 7 days', from: (t) => shift(t, -6), to: (t) => t },
  last14: { label: 'Last 14 days', from: (t) => shift(t, -13), to: (t) => t },
  last30: { label: 'Last 30 days', from: (t) => shift(t, -29), to: (t) => t },
  thisMonth: { label: 'This month', from: (t) => `${t.slice(0, 7)}-01`, to: (t) => t },
  custom: { label: 'Custom range…', custom: true },
};

function shift(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Facebook's delivery statuses, reduced to the three things worth seeing at a
 * glance. `effective_status` already folds in the campaign above the adset, so
 * CAMPAIGN_PAUSED shows as paused rather than a misleading active.
 */
const statusTone = (s) => {
  const v = String(s || '').toUpperCase();
  if (v === 'ACTIVE') return 'badge-ok';
  if (v.includes('PAUSED') || v === 'ARCHIVED' || v === 'DELETED') return 'badge-idle';
  if (v === 'DISAPPROVED' || v === 'WITH_ISSUES') return 'badge-bad';
  return 'badge-pending';
};

const statusLabel = (s) => String(s || '').toLowerCase().replace(/_/g, ' ') || '—';

/**
 * Every column, in display order. `numeric` decides the comparator and the
 * default direction: a number column opens largest-first, because the question
 * is almost always "where is the money", while a name opens A–Z.
 */
const COLUMNS = [
  /* Pinned: the switch is how a row gets turned off, so hiding it would take
     the control away with no way back. Its width is fixed because the two
     frozen columns are positioned against it. */
  { key: 'status', label: 'On', sortable: false, pinned: true, resizable: false,
    width: 52, sticky: 'col-pin-a' },
  { key: 'adsetName',   label: 'Adset',   width: 260, sticky: 'col-pin-b' },
  { key: 'budget',      label: 'Budget',  numeric: true },
  { key: 'spend',       label: 'Spend',   numeric: true },
  { key: 'revenue',     label: 'Revenue', numeric: true },
  { key: 'profit',      label: 'Profit',  numeric: true },
  { key: 'roi',         label: 'ROI',     numeric: true },
  { key: 'cpl',         label: 'CPL',     numeric: true, title: 'Spend ÷ Tonic conversions' },
  { key: 'rpc',         label: 'RPC',     numeric: true, title: 'Revenue ÷ Tonic conversions' },
  { key: 'leads',       label: 'Leads',   numeric: true, title: 'Leads reported by Facebook' },
  { key: 'conversions', label: 'Conv.',   numeric: true, title: 'Tonic session clicks' },
  { key: 'impressions', label: 'Impr.',   numeric: true },
  { key: 'clicks',      label: 'Clicks',  numeric: true },
];

const money = (n) => `${Number(n || 0).toFixed(2)} $`;
const int = (n) => Number(n || 0).toLocaleString();
const dash = <span className="muted">—</span>;

/** Profit and ROI are the two numbers people act on, so they are coloured. */
const tone = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

export default function FinalData() {
  const toast = useToast();

  // Opens on today; the first question is almost always "how is it doing now".
  const [rangeKey, setRangeKey] = useState('today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [today, setToday] = useState('');
  const [search, setSearch] = useState('');
  const [onlyMatched, setOnlyMatched] = useState(false);
  const [sort, setSort] = useState({ key: 'spend', dir: 'desc' });

  /* Which columns show and how wide they are, remembered in this browser. */
  const { hidden, visible, widths, toggle, setWidth, reset, customised } =
    useColumnPrefs('tonic.finalData.columns', COLUMNS);

  /* The unmatched list is a diagnostic, not part of the daily read, so it
     stays folded away until asked for. */
  const [showUnmatched, setShowUnmatched] = useState(false);

  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [accountFilter, setAccountFilter] = useState('');
  const [accountsLoading, setAccountsLoading] = useState(true);

  // Which budget cell is open for editing, and what is typed in it.
  const [editingBudget, setEditingBudget] = useState(null);
  const [budgetDraft, setBudgetDraft] = useState('');
  const [savingBudget, setSavingBudget] = useState(false);
  const [togglingAdset, setTogglingAdset] = useState(null);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(null); // 'tonic' | 'facebook'

  // Tonic's clock is PST/PDT; using the browser's date would ask for the wrong
  // day for anyone outside California.
  useEffect(() => {
    api.stats.today()
      .then((r) => setToday(r.today || new Date().toISOString().slice(0, 10)))
      .catch(() => setToday(new Date().toISOString().slice(0, 10)));
  }, []);

  useEffect(() => {
    api.fbSettings.accounts()
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
    // Nothing to fetch without an account. Clear the spinner rather than
    // leaving it turning forever, which is what a bare return did.
    if (!accountId) {
      if (!accountsLoading) setLoading(false);
      return;
    }
    if (!range) return;
    setLoading(true);
    try {
      setData(await api.finalData.get({ ...range, account: accountId }));
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

  /** Remembered server-side, so the screen opens on the same account next time. */
  const chooseAccount = (id) => {
    setAccountId(id);
    api.fbSettings.selectAccount(id).catch(() => {});
  };

  const visibleAccounts = useMemo(() => {
    const q = accountFilter.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter((a) =>
      `${a.name} ${a.accountId}`.toLowerCase().includes(q)
    );
  }, [accounts, accountFilter]);

  const currentAccount = accounts.find((a) => a.id === accountId) || null;

  const chooseRange = (key) => {
    if (key === 'custom' && today && (!customFrom || !customTo)) {
      setCustomFrom(shift(today, -6));
      setCustomTo(today);
    }
    setRangeKey(key);
  };

  const openBudget = (row) => {
    // Lifetime budgets are not editable here; Meta needs a different field and
    // changing one mid-flight has consequences this screen can't explain well.
    if (row.budget == null || row.budgetType !== 'daily') return;
    setEditingBudget(row.adsetId);
    setBudgetDraft(String(row.budget));
  };

  const saveBudget = async (row) => {
    const amount = Number(budgetDraft);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('Enter a daily budget greater than zero.');
      return;
    }
    if (amount === row.budget) {
      setEditingBudget(null);
      return;
    }

    setSavingBudget(true);
    try {
      const res = await api.finalData.setBudget(row.budgetOwnerId, amount, accountId);
      // Patch in place rather than refetching — a reload would re-pull every
      // Tonic day for one number. Every row sharing this budget updates, since
      // a campaign budget is one number behind several adsets.
      setData((d) => ({
        ...d,
        rows: d.rows.map((r) =>
          r.budgetOwnerId === row.budgetOwnerId ? { ...r, budget: res.budget } : r
        ),
      }));
      setEditingBudget(null);
      toast.success(
        row.budgetLevel === 'campaign'
          ? `Campaign budget set to ${money(res.budget)} — it covers every adset in ${row.campaignName || 'this campaign'}.`
          : `${row.adsetName || row.adsetId} daily budget set to ${money(res.budget)}.`
      );
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingBudget(false);
    }
  };

  const toggleAdset = async (row, active) => {
    setTogglingAdset(row.adsetId);
    try {
      const res = await api.finalData.setAdsetStatus(row.adsetId, active);
      setData((d) => ({
        ...d,
        rows: d.rows.map((r) => (r.adsetId === row.adsetId ? { ...r, status: res.status } : r)),
      }));
      toast.success(`${row.adsetName || row.adsetId} ${active ? 'turned on' : 'paused'}.`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setTogglingAdset(null);
    }
  };

  const rows = useMemo(() => {
    let list = data?.rows || [];
    if (onlyMatched) list = list.filter((r) => r.matched);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((r) =>
        [r.adsetName, r.campaignName, r.adsetId, r.status]
          .some((v) => String(v || '').toLowerCase().includes(q))
      );
    }
    return sortRows(list, COLUMNS, sort);
  }, [data, onlyMatched, search, sort]);

  const toggleSort = (col) => setSort((s) => nextSort(s, col));

  if (blocked) {
    return (
      <Layout title="Final Data">
        <div className="banner banner-warn">
          <span>⚠</span>
          <div>
            {blocked === 'tonic' ? (
              <>No Tonic credentials yet. Add them on the <Link to="/settings">Settings</Link> screen.</>
            ) : (
              <>No Facebook credentials yet. Add an access token and ad account on the <Link to="/fb-settings">FB Settings</Link> screen.</>
            )}
          </div>
        </div>
      </Layout>
    );
  }

  const t = data?.totals;

  /* One cell, by column key. Driving the body off the same list as the header
     is what keeps the two in step: the previous hand-written rows had the
     switch and the adset name in the opposite order to their headings. */
  const budgetCell = (r) => (
    editingBudget === r.adsetId ? (
      <input
        type="number"
        min="1"
        step="1"
        value={budgetDraft}
        autoFocus
        disabled={savingBudget}
        onChange={(e) => setBudgetDraft(e.target.value)}
        onBlur={() => saveBudget(r)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') saveBudget(r);
          if (e.key === 'Escape') setEditingBudget(null);
        }}
        style={{ width: 90, textAlign: 'right', padding: '4px 6px' }}
        aria-label={`Daily budget for ${r.adsetName || r.adsetId}`}
      />
    ) : r.budget != null && r.budgetType === 'daily' ? (
      <button
        className="btn btn-ghost"
        style={{ padding: '2px 6px' }}
        onClick={() => openBudget(r)}
        title={r.budgetLevel === 'campaign'
          ? `Campaign budget for ${r.campaignName || 'this campaign'} — changing it affects every adset in it`
          : 'Click to change the daily budget'}
      >
        {money(r.budget)}
        {r.budgetLevel === 'campaign' && (
          <span className="muted" style={{ fontSize: 10, marginLeft: 4 }}>CBO</span>
        )}
      </button>
    ) : r.budget != null ? (
      <span className="muted" title="Lifetime budget — change it in Ads Manager">
        {money(r.budget)} total
      </span>
    ) : (
      <span className="muted" title="No budget found on this adset or its campaign">—</span>
    )
  );

  const cell = (col, r) => {
    switch (col.key) {
      case 'status':
        return (
          <Switch
            checked={String(r.status || '').toUpperCase() === 'ACTIVE'}
            busy={togglingAdset === r.adsetId}
            onChange={(v) => toggleAdset(r, v)}
            label={`${r.adsetName || r.adsetId} — ${statusLabel(r.status)}`}
          />
        );
      case 'adsetName':
        return (
          <>
            {/* New tab, as asked — so the table you were reading stays where it
                was while you look at one adset's history. */}
            <a
              className="link"
              href={`/final-data/adsets/${r.adsetId}?account=${encodeURIComponent(accountId)}`}
              target="_blank"
              rel="noreferrer"
              title="Open this adset's day-by-day history in a new tab"
            >
              {r.adsetName || r.adsetId}
            </a>
            <div className="muted mono" style={{ fontSize: 11 }}>
              {r.adsetId}
              {/* The delivery state still matters when it is not simply on or
                  off — a campaign-level pause is not the adset's own doing,
                  and the switch cannot show that. */}
              {!['ACTIVE', 'PAUSED'].includes(String(r.status || '').toUpperCase()) && (
                <span className={`badge ${statusTone(r.status)}`} style={{ marginLeft: 6 }}>
                  {statusLabel(r.status)}
                </span>
              )}
            </div>
          </>
        );
      case 'budget':  return budgetCell(r);
      case 'spend':   return money(r.spend);
      case 'revenue':
        return r.matched ? money(r.revenue) : (
          <span className="muted" title="No Tonic sessions carried this adset ID">—</span>
        );
      case 'profit':  return money(r.profit);
      case 'roi':     return r.roi == null ? dash : `${r.roi} %`;
      case 'cpl':     return r.cpl == null ? dash : money(r.cpl);
      case 'rpc':     return r.rpc == null ? dash : money(r.rpc);
      default:        return int(r[col.key]);
    }
  };

  const footCell = (col, totals) => {
    switch (col.key) {
      case 'status':
      case 'adsetName': return null;
      case 'budget':    return money(totals.budget);
      case 'spend':     return money(totals.spend);
      case 'revenue':   return money(totals.revenue);
      case 'profit':    return money(totals.profit);
      case 'roi':       return totals.roi == null ? dash : `${totals.roi} %`;
      case 'cpl':       return totals.cpl == null ? dash : money(totals.cpl);
      case 'rpc':       return totals.rpc == null ? dash : money(totals.rpc);
      default:          return int(totals[col.key]);
    }
  };

  /* "Total" goes in the Adset column where there is one, which is where it has
     always appeared — not in the 52px switch column, which would clip it. With
     the Adset column hidden it falls back to the first cell. */
  const totalLabelAt = Math.max(0, visible.findIndex((c) => c.key === 'adsetName'));

  /* Profit and ROI are the two numbers people act on, so they carry a colour
     in the body and in the totals alike. */
  const tdClass = (col, row) => [
    col.numeric ? 'num' : '',
    col.sticky || '',
    row && (col.key === 'profit' || col.key === 'roi') ? tone(row[col.key]) : '',
  ].filter(Boolean).join(' ') || undefined;

  return (
    <Layout
      title="Final Data"
      tools={
        <select
          className="topbar-select"
          value={accountId}
          onChange={(e) => chooseAccount(e.target.value)}
          disabled={accountsLoading || accounts.length === 0}
          aria-label="Ad account"
          title={currentAccount ? `${currentAccount.name} · ${currentAccount.id}` : 'Ad account'}
        >
          {accountsLoading && <option value="">Loading…</option>}
          {!accountsLoading && accounts.length === 0 && <option value="">No ad accounts</option>}
          {visibleAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}{a.currency ? ` (${a.currency})` : ''}{a.active ? '' : ' — inactive'}
            </option>
          ))}
        </select>
      }
      actions={
        <button className="btn btn-secondary" onClick={load} disabled={loading}>
          {loading && <span className="spinner" />}
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      }
    >
      <div className="card">
        <div className="card-head" style={{ flexWrap: 'wrap' }}>
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
              <div className="toolbar" style={{ gap: 6 }}>
                <input
                  type="date"
                  value={customFrom}
                  max={customTo || today || undefined}
                  min={today ? shift(today, -49) : undefined}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  style={{ width: 'auto' }}
                  aria-label="Start date"
                />
                <span className="muted" style={{ fontSize: 12 }}>to</span>
                <input
                  type="date"
                  value={customTo}
                  min={customFrom || undefined}
                  max={today || undefined}
                  onChange={(e) => setCustomTo(e.target.value)}
                  style={{ width: 'auto' }}
                  aria-label="End date"
                />
              </div>
            )}

            <button
              className={`chip ${onlyMatched ? 'on' : ''}`}
              onClick={() => setOnlyMatched((v) => !v)}
              title="Hide adsets with no Tonic revenue against them"
            >
              matched only
            </button>

            <SearchBox
              value={search}
              onSearch={setSearch}
              placeholder="Search adset or campaign"
              /* These rows are already on screen, so filtering is local and a
                 one-character search should work; the 3-character floor exists
                 for the API-side searches elsewhere. */
              minLength={1}
              width={240}
            />

            <ColumnsMenu
              columns={COLUMNS}
              hidden={hidden}
              toggle={toggle}
              reset={reset}
              customised={customised}
            />
          </div>

          {data?.meta && (
            <div className="muted" style={{ fontSize: 12 }}>
              {data.meta.matched} of {data.meta.adsets} adsets matched on{' '}
              <code>{data.meta.param}</code>
              {data.meta.daysFromCache > 0 && ` · ${data.meta.daysFromCache} days from cache`}
            </div>
          )}
        </div>

        {loading ? (
          <div className="empty">Loading…</div>
        ) : accounts.length === 0 ? (
          <div className="empty">
            <p>No ad accounts are reachable with the current Facebook token.</p>
            <p className="hint">
              Check the token on the <Link to="/fb-settings">FB Settings</Link> screen. If it
              reports “API access blocked”, the Meta app behind the token needs the Marketing
              API product added.
            </p>
          </div>
        ) : rows.length === 0 ? (
          <div className="empty">
            <p>No adsets with spend in this range.</p>
          </div>
        ) : (
          /* Thirteen columns do not fit a phone, and compressing them makes
             every one unreadable. The table keeps real widths and scrolls
             inside this container; the toolbar above it stays put. Hiding
             columns shrinks the minimum width with them, so turning a few off
             genuinely buys room rather than just widening the rest. */
          <div
            className="table-scroll"
            style={{ '--table-min': tableMinWidth(visible, widths) }}
          >
          <table>
            <thead>
              <HeaderRow
                columns={visible}
                widths={widths}
                setWidth={setWidth}
                sort={sort}
                onSort={toggleSort}
              />
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.adsetId}>
                  {visible.map((col) => (
                    <td key={col.key} className={tdClass(col, r)}>{cell(col, r)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
            {t && (
              <tfoot>
                <tr className="summary-row">
                  {/* No colSpan anywhere: the label sits in the first visible
                      column and every other cell is produced by the same list
                      the header and body use, so a total cannot drift a column
                      away from what it totals. */}
                  {visible.map((col, i) => (
                    <td
                      key={col.key}
                      className={i === totalLabelAt
                        ? ['label', col.sticky].filter(Boolean).join(' ')
                        : tdClass(col, t)}
                    >
                      {i === totalLabelAt ? 'Total' : footCell(col, t)}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
          </div>
        )}
      </div>

      {data?.unmatched?.length > 0 && (
        <div className="card">
          <div
            className="card-head disclosure"
            role="button"
            tabIndex={0}
            aria-expanded={showUnmatched}
            onClick={() => setShowUnmatched((v) => !v)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setShowUnmatched((v) => !v);
              }
            }}
          >
            <h2>
              <span className={`disclosure-caret ${showUnmatched ? 'open' : ''}`} aria-hidden="true">▸</span>
              Tonic revenue with no Facebook adset
              <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
                {data.unmatched.length} value{data.unmatched.length === 1 ? '' : 's'}
              </span>
            </h2>
            <div className="muted" style={{ fontSize: 12 }}>
              {money(data.totals.unmatchedRevenue)} in total
            </div>
          </div>
          {showUnmatched && (
          <>
          <p className="hint" style={{ padding: '0 16px' }}>
            Sessions whose <code>{data.meta.param}</code> value matches no adset in this ad account —
            traffic from elsewhere, an adset outside the range, or a tracking link that is not
            passing the adset ID. <code>(not set)</code> means the parameter was missing entirely.
          </p>
          <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{data.meta.param}</th>
                <th className="num">Sessions</th>
                <th className="num">Clicks</th>
                <th className="num">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {data.unmatched.map((r) => (
                <tr key={r.key}>
                  <td className="mono">{r.key}</td>
                  <td className="num">{int(r.sessions)}</td>
                  <td className="num">{int(r.clicks)}</td>
                  <td className="num">{money(r.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          </>
          )}
        </div>
      )}
      {(data?.notes || []).length > 0 && (
        <div className="footnotes">
          {data.notes.map((note, i) => <p className="note" key={i}>{note}</p>)}
        </div>
      )}
    </Layout>
  );
}
