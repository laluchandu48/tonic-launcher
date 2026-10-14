import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Layout from '../components/Layout.jsx';
import { useToast } from '../components/Toast.jsx';
import { api } from '../lib/api.js';

/**
 * The join parameter is the whole trick behind Final Data: it names the
 * tracking-link parameter that carries the Facebook adset ID into Tonic. Get it
 * wrong and every row shows spend with no revenue, so the screen says plainly
 * what it is and where to check it.
 */
export default function FbSettings() {
  const toast = useToast();

  const [state, setState] = useState(null);
  const [token, setToken] = useState('');
  const [apiVersion, setApiVersion] = useState('');
  const [joinParam, setJoinParam] = useState('');
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [identity, setIdentity] = useState(null);

  /* The ad accounts the dashboard totals. Held as a Set while being edited and
     saved in one go, so a slow save cannot leave half a selection stored. */
  const [accounts, setAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState(null);
  const [chosen, setChosen] = useState(() => new Set());
  const [savedChosen, setSavedChosen] = useState(() => new Set());
  const [savingAccounts, setSavingAccounts] = useState(false);
  const [accountFilter, setAccountFilter] = useState('');

  const load = async () => {
    try {
      const s = await api.fbSettings.get();
      setState(s);
      setApiVersion(s.apiVersion || '');
      setJoinParam(s.joinParam || '');
      const saved = new Set(s.dashboardAccounts || []);
      setChosen(saved);
      setSavedChosen(saved);
      if (s.configured) loadAccounts();
    } catch (err) {
      toast.error(err.message);
    }
  };

  useEffect(() => { load(); }, []);

  const loadAccounts = async () => {
    setAccountsLoading(true);
    setAccountsError(null);
    try {
      const { accounts: list, dashboardAccounts } = await api.fbSettings.accounts();
      setAccounts(list || []);
      if (Array.isArray(dashboardAccounts)) {
        const saved = new Set(dashboardAccounts);
        setChosen(saved);
        setSavedChosen(saved);
      }
    } catch (err) {
      /* Shown in place rather than as a toast: this is the one message that
         explains an empty dashboard, and a toast disappears before it is read. */
      setAccountsError(err.message);
      setAccounts([]);
    } finally {
      setAccountsLoading(false);
    }
  };

  const toggleAccount = (id) => setChosen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const saveAccounts = async () => {
    setSavingAccounts(true);
    try {
      const { dashboardAccounts } = await api.fbSettings.saveDashboardAccounts([...chosen]);
      const saved = new Set(dashboardAccounts || []);
      setChosen(saved);
      setSavedChosen(saved);
      toast.success(
        saved.size
          ? `Dashboard will total ${saved.size} ad account${saved.size === 1 ? '' : 's'}.`
          : 'Cleared — the dashboard will fall back to every account the token can see.'
      );
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingAccounts(false);
    }
  };

  const visibleAccounts = accounts.filter((a) => {
    const q = accountFilter.trim().toLowerCase();
    return !q || `${a.name} ${a.id} ${a.businessName || ''}`.toLowerCase().includes(q);
  });

  const dirty = chosen.size !== savedChosen.size || [...chosen].some((id) => !savedChosen.has(id));

  const save = async () => {
    setSaving(true);
    setErrors({});
    try {
      const res = await api.fbSettings.save({
        accessToken: token.trim() || undefined,
        apiVersion,
        joinParam,
      });
      setToken('');
      setIdentity(res.identity);
      toast.success(
        res.identity?.accounts
          ? `Connected — ${res.identity.accounts} ad account${res.identity.accounts === 1 ? '' : 's'} visible.`
          : 'Connected.'
      );
      load();
    } catch (err) {
      if (err.fields) setErrors(err.fields);
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const res = await api.fbSettings.test();
      setIdentity(res.identity);
      toast.success(`Token works — ${res.identity?.accounts ?? 0} ad accounts visible.`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setTesting(false);
    }
  };

  const clear = async () => {
    try {
      await api.fbSettings.clear();
      setIdentity(null);
      setToken('');
      toast.success('Facebook credentials removed.');
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const known = state?.knownJoinParams || [];
  const isCustomParam = Boolean(joinParam) && !known.includes(joinParam);

  return (
    <Layout title="FB Settings">
      <div className="card">
        <div className="card-head">
          <h2>Facebook Marketing API</h2>
          {state?.configured && <span className="badge badge-ok">configured</span>}
        </div>

        <div style={{ padding: 16, display: 'grid', gap: 16 }}>
          {state?.fromEnv && (
            <div className="banner banner-warn">
              <span>⚠</span>
              <div>
                These are set in the server environment, which overrides anything saved here.
              </div>
            </div>
          )}

          <div className="field">
            <label htmlFor="fb-token">Access token</label>
            <p className="hint">
              A long-lived token with the <code>ads_read</code> permission — a system user token
              from Business Settings is the one that does not expire on you. The launcher only
              reads; it never changes anything in your ad account.
              {state?.maskedToken && <> Currently stored: <code>{state.maskedToken}</code>.</>}
            </p>
            <input
              id="fb-token"
              type="password"
              autoComplete="off"
              className={errors.accessToken ? 'invalid' : ''}
              value={token}
              placeholder={state?.maskedToken ? 'Leave blank to keep the stored token' : 'EAAG…'}
              onChange={(e) => setToken(e.target.value)}
            />
            {errors.accessToken && <p className="error-text">{errors.accessToken}</p>}
          </div>

          <div className="field">
            <label htmlFor="fb-version">Graph API version</label>
            <p className="hint">
              Meta supports a version for about two years. Bump it here when yours is retired.
            </p>
            <input
              id="fb-version"
              type="text"
              className={errors.apiVersion ? 'invalid' : ''}
              value={apiVersion}
              placeholder={state?.defaults?.apiVersion || 'v24.0'}
              onChange={(e) => setApiVersion(e.target.value)}
              style={{ maxWidth: 200 }}
            />
            {errors.apiVersion && <p className="error-text">{errors.apiVersion}</p>}
          </div>

          <div className="field">
            <label htmlFor="fb-join">Adset ID parameter</label>
            <p className="hint">
              The tracking-link parameter that carries the Facebook adset ID into Tonic. If your
              link ends with <code>&amp;subid2=&#123;&#123;adset.id&#125;&#125;</code> then this is{' '}
              <code>subid2</code>. Check the tracking link on any campaign in Tonic if you are not
              sure — get this wrong and <Link to="/final-data">Final Data</Link> shows spend with
              no revenue against it.
            </p>
            <select
              id="fb-join"
              value={isCustomParam ? '__custom' : joinParam}
              onChange={(e) => setJoinParam(e.target.value === '__custom' ? '' : e.target.value)}
              style={{ marginBottom: isCustomParam ? 8 : 0 }}
            >
              {known.map((p) => <option key={p} value={p}>{p}</option>)}
              <option value="__custom">Custom parameter…</option>
            </select>
            {isCustomParam && (
              <input
                type="text"
                value={joinParam}
                placeholder="myCustomParam"
                onChange={(e) => setJoinParam(e.target.value)}
              />
            )}
            {errors.joinParam && <p className="error-text">{errors.joinParam}</p>}
          </div>

          {identity && (
            <div className="summary">
              <dl>
                <dt>Authenticated as</dt>
                <dd>{identity.user || '—'}</dd>
                <dt>Ad accounts</dt>
                <dd>
                  {identity.accounts}
                  {identity.first && (
                    <span className="muted"> · e.g. {identity.first.name}</span>
                  )}
                </dd>
              </dl>
              <p className="hint" style={{ marginTop: 10 }}>
                Pick which one to report on at the top of{' '}
                <Link to="/final-data">Final Data</Link>.
              </p>
            </div>
          )}

          <div className="toolbar">
            <button className="btn" onClick={save} disabled={saving}>
              {saving && <span className="spinner" />}
              {saving ? 'Checking…' : 'Save and verify'}
            </button>
            <button className="btn btn-secondary" onClick={test} disabled={testing || !state?.configured}>
              {testing && <span className="spinner" />}
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            {state?.configured && !state?.fromEnv && (
              <button className="btn btn-danger" onClick={clear}>Remove</button>
            )}
          </div>

          <p className="hint">
            The token is kept on the server and never sent to the browser — this screen only ever
            sees a masked version of it. It is excluded from the Git repository along with the
            rest of <code>server/data/</code>.
          </p>
        </div>
      </div>

      {/* ── Which ad accounts the dashboard totals ── */}
      {state?.configured && (
        <div className="card">
          <div className="card-head" style={{ flexWrap: 'wrap', gap: 10 }}>
            <h2>Dashboard ad accounts</h2>
            <div className="toolbar">
              {accounts.length > 0 && (
                <input
                  type="text"
                  value={accountFilter}
                  placeholder="Filter accounts"
                  onChange={(e) => setAccountFilter(e.target.value)}
                  style={{ width: 200 }}
                  aria-label="Filter ad accounts"
                />
              )}
              <button className="btn btn-secondary" onClick={loadAccounts} disabled={accountsLoading}>
                {accountsLoading && <span className="spinner" />}
                {accountsLoading ? 'Loading…' : 'Reload'}
              </button>
            </div>
          </div>

          <p className="hint" style={{ padding: '0 18px' }}>
            Tick the accounts the dashboard should add up. Every account costs two Facebook calls,
            taken one at a time, so a short list is the difference between seconds and minutes.
            With none ticked the dashboard falls back to every account this token can see.
          </p>

          {accountsError ? (
            <div className="empty">
              <p>{accountsError}</p>
              <p className="hint">
                If this says API access is blocked, the Meta app behind the token has no Marketing
                API product — no selection here will fix that.
              </p>
            </div>
          ) : accountsLoading ? (
            <div className="empty">Loading ad accounts…</div>
          ) : accounts.length === 0 ? (
            <div className="empty">This token cannot see any ad accounts.</div>
          ) : (
            <>
              <div className="account-picks">
                {visibleAccounts.map((a) => (
                  <label className="account-pick" key={a.id}>
                    <input
                      type="checkbox"
                      checked={chosen.has(a.id)}
                      onChange={() => toggleAccount(a.id)}
                    />
                    <span>
                      {a.name}
                      <span className="muted mono" style={{ display: 'block', fontSize: 11 }}>
                        {a.id}
                        {a.currency ? ` · ${a.currency}` : ''}
                        {a.businessName ? ` · ${a.businessName}` : ''}
                        {a.active ? '' : ' · inactive'}
                      </span>
                    </span>
                  </label>
                ))}
              </div>

              <div className="toolbar" style={{ padding: '0 18px 18px' }}>
                <button className="btn" onClick={saveAccounts} disabled={savingAccounts || !dirty}>
                  {savingAccounts && <span className="spinner" />}
                  {savingAccounts ? 'Saving…' : dirty ? 'Save selection' : 'Saved'}
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => setChosen(new Set(visibleAccounts.map((a) => a.id)))}
                  disabled={visibleAccounts.length === 0}
                >
                  Select all{accountFilter ? ' shown' : ''}
                </button>
                <button className="btn btn-ghost" onClick={() => setChosen(new Set())} disabled={chosen.size === 0}>
                  Clear
                </button>
                <span className="muted" style={{ fontSize: 12 }}>
                  {chosen.size} of {accounts.length} selected
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </Layout>
  );
}
