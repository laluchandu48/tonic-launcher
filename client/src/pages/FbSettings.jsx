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

  const load = async () => {
    try {
      const s = await api.fbSettings.get();
      setState(s);
      setApiVersion(s.apiVersion || '');
      setJoinParam(s.joinParam || '');
    } catch (err) {
      toast.error(err.message);
    }
  };

  useEffect(() => { load(); }, []);

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
    </Layout>
  );
}
