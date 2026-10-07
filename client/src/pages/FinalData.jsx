import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Layout from '../components/Layout.jsx';
import SearchBox from '../components/SearchBox.jsx';
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

const money = (n) => `${Number(n || 0).toFixed(2)} $`;
const int = (n) => Number(n || 0).toLocaleString();
const dash = <span className="muted">—</span>;

/** Profit and ROI are the two numbers people act on, so they are coloured. */
const tone = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

export default function FinalData() {
  const toast = useToast();

  const [rangeKey, setRangeKey] = useState('last30');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [today, setToday] = useState('');
  const [search, setSearch] = useState('');
  const [onlyMatched, setOnlyMatched] = useState(false);

  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [accountFilter, setAccountFilter] = useState('');
  const [accountsLoading, setAccountsLoading] = useState(true);

  // Which budget cell is open for editing, and what is typed in it.
  const [editingBudget, setEditingBudget] = useState(null);
  const [budgetDraft, setBudgetDraft] = useState('');
  const [savingBudget, setSavingBudget] = useState(false);

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
    if (!range || !accountId) return;
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
  }, [range, accountId]);

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
    if (row.dailyBudget == null) return;   // campaign-level budget: not ours to set
    setEditingBudget(row.adsetId);
    setBudgetDraft(String(row.dailyBudget));
  };

  const saveBudget = async (row) => {
    const amount = Number(budgetDraft);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('Enter a daily budget greater than zero.');
      return;
    }
    if (amount === row.dailyBudget) {
      setEditingBudget(null);
      return;
    }

    setSavingBudget(true);
    try {
      const res = await api.finalData.setBudget(row.adsetId, amount, accountId);
      // Patch the row in place rather than refetching — a full reload would
      // re-pull every Tonic day for one number.
      setData((d) => ({
        ...d,
        rows: d.rows.map((r) => (r.adsetId === row.adsetId ? { ...r, dailyBudget: res.dailyBudget } : r)),
      }));
      setEditingBudget(null);
      toast.success(`${row.adsetName || row.adsetId} daily budget set to ${money(res.dailyBudget)}.`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingBudget(false);
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
    return list;
  }, [data, onlyMatched, search]);

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

  return (
    <Layout
      title="Final Data"
      actions={
        <button className="btn btn-secondary" onClick={load} disabled={loading}>
          {loading && <span className="spinner" />}
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      }
    >
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head" style={{ flexWrap: 'wrap', gap: 10 }}>
          <div className="toolbar" style={{ flexWrap: 'wrap' }}>
            <label htmlFor="fd-account" style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
              Ad account
            </label>
            <select
              id="fd-account"
              value={accountId}
              onChange={(e) => chooseAccount(e.target.value)}
              disabled={accountsLoading || accounts.length === 0}
              style={{ width: 'auto', minWidth: 280 }}
            >
              {accountsLoading && <option value="">Loading…</option>}
              {!accountsLoading && accounts.length === 0 && <option value="">No ad accounts</option>}
              {visibleAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}{a.currency ? ` (${a.currency})` : ''}{a.active ? '' : ' — inactive'}
                </option>
              ))}
            </select>

            {/* An agency token can see hundreds of accounts, so the list is
                filterable rather than something to scroll through. */}
            {accounts.length > 8 && (
              <input
                type="search"
                value={accountFilter}
                placeholder="Filter accounts…"
                onChange={(e) => setAccountFilter(e.target.value)}
                style={{ width: 'auto', minWidth: 180 }}
                aria-label="Filter ad accounts"
              />
            )}
          </div>

          {currentAccount && (
            <div className="muted mono" style={{ fontSize: 12 }}>
              {currentAccount.id}
              {accountFilter && visibleAccounts.length !== accounts.length &&
                ` · ${visibleAccounts.length} of ${accounts.length} shown`}
            </div>
          )}
        </div>
      </div>

      {(data?.notes || []).map((note, i) => (
        <div className="banner banner-warn" key={i}>
          <span>⚠</span>
          <div>{note}</div>
        </div>
      ))}

      {t && (
        <div className="stats">
          <div className="stat">
            <div className="stat-label">Spend</div>
            <div className="stat-value">{money(t.spend)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Revenue</div>
            <div className="stat-value">{money(t.revenue)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Profit</div>
            <div className={`stat-value ${tone(t.profit)}`}>{money(t.profit)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">ROI</div>
            <div className={`stat-value ${tone(t.roi)}`}>{t.roi == null ? '—' : `${t.roi} %`}</div>
          </div>
        </div>
      )}

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
        ) : rows.length === 0 ? (
          <div className="empty">
            <p>No adsets with spend in this range.</p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Adset</th>
                <th>Status</th>
                <th className="num">Budget</th>
                <th className="num">Spend</th>
                <th className="num">Revenue</th>
                <th className="num">Profit</th>
                <th className="num">ROI</th>
                <th className="num" title="Spend ÷ Tonic conversions">CPL</th>
                <th className="num" title="Revenue ÷ Tonic conversions">RPC</th>
                <th className="num" title="Leads reported by Facebook">Leads</th>
                <th className="num" title="Tonic session clicks">Conv.</th>
                <th className="num">Impr.</th>
                <th className="num">Clicks</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.adsetId}>
                  <td>
                    {r.adsetName || <span className="mono">{r.adsetId}</span>}
                    <div className="muted mono" style={{ fontSize: 11 }}>{r.adsetId}</div>
                  </td>
                  <td>
                    <span className={`badge ${statusTone(r.status)}`}>{statusLabel(r.status)}</span>
                  </td>
                  <td className="num">
                    {editingBudget === r.adsetId ? (
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
                    ) : r.dailyBudget != null ? (
                      <button
                        className="btn btn-ghost"
                        style={{ padding: '2px 6px' }}
                        onClick={() => openBudget(r)}
                        title="Click to change the daily budget"
                      >
                        {money(r.dailyBudget)}
                      </button>
                    ) : r.lifetimeBudget != null ? (
                      <span className="muted" title="Lifetime budget — edit it in Ads Manager">
                        {money(r.lifetimeBudget)} total
                      </span>
                    ) : (
                      <span className="muted" title="The campaign holds the budget (Advantage campaign budget), so it cannot be set per adset">
                        campaign
                      </span>
                    )}
                  </td>
                  <td className="num">{money(r.spend)}</td>
                  <td className="num">
                    {r.matched ? money(r.revenue) : (
                      <span className="muted" title="No Tonic sessions carried this adset ID">—</span>
                    )}
                  </td>
                  <td className={`num ${tone(r.profit)}`}>{money(r.profit)}</td>
                  <td className={`num ${tone(r.roi)}`}>{r.roi == null ? dash : `${r.roi} %`}</td>
                  <td className="num">{r.cpl == null ? dash : money(r.cpl)}</td>
                  <td className="num">{r.rpc == null ? dash : money(r.rpc)}</td>
                  <td className="num">{int(r.leads)}</td>
                  <td className="num">{int(r.conversions)}</td>
                  <td className="num">{int(r.impressions)}</td>
                  <td className="num">{int(r.clicks)}</td>
                </tr>
              ))}
            </tbody>
            {t && (
              <tfoot>
                <tr className="summary-row">
                  <td className="label" colSpan={2}>Total</td>
                  <td className="num">{money(t.dailyBudget)}</td>
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
        )}
      </div>

      {data?.unmatched?.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>Tonic revenue with no Facebook adset</h2>
            <div className="muted" style={{ fontSize: 12 }}>
              {money(data.totals.unmatchedRevenue)} in total
            </div>
          </div>
          <p className="hint" style={{ padding: '0 16px' }}>
            Sessions whose <code>{data.meta.param}</code> value matches no adset in this ad account —
            traffic from elsewhere, an adset outside the range, or a tracking link that is not
            passing the adset ID. <code>(not set)</code> means the parameter was missing entirely.
          </p>
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
              {data.unmatched.slice(0, 50).map((r) => (
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
      )}
    </Layout>
  );
}
