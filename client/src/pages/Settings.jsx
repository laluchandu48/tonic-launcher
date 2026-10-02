import { useEffect, useState } from 'react';
import Layout from '../components/Layout.jsx';
import { useToast } from '../components/Toast.jsx';
import { api } from '../lib/api.js';

export default function Settings() {
  const toast = useToast();
  const [status, setStatus] = useState(null);
  const [consumerKey, setConsumerKey] = useState('');
  const [consumerSecret, setConsumerSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const load = () => api.settings.get().then(setStatus).catch((e) => toast.error(e.message));
  useEffect(() => { load(); }, []);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      // The server authenticates against Tonic before accepting these, so a
      // success here means the credentials genuinely work.
      const next = await api.settings.save(consumerKey.trim(), consumerSecret.trim());
      setStatus(next);
      setConsumerKey('');
      setConsumerSecret('');
      toast.success('Credentials verified and saved.');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const result = await api.settings.test();
      const expiry = new Date(result.tokenExpiresAt).toLocaleTimeString();
      toast.success(`Connected. Token valid until ${expiry}.`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setTesting(false);
    }
  };

  const disconnect = async () => {
    try {
      setStatus(await api.settings.clear());
      toast.info('Credentials removed.');
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <Layout title="Settings">
      <div className="card" style={{ maxWidth: 680 }}>
        <div className="card-head">
          <h2>Tonic API credentials</h2>
          {status?.configured && <span className="badge badge-ok">Connected</span>}
        </div>
        <div className="card-body">
          <p className="hint" style={{ marginTop: 0 }}>
            These come from Account Settings in the Tonic publisher dashboard. They are stored on
            this server and are never sent to the browser. Tonic credentials expire between 3 and
            12 months depending on what you chose when creating them.
          </p>

          {status?.managedByEnv && (
            <div className="banner banner-warn">
              <span>⚠</span>
              <div>Credentials are set through the environment file, which takes precedence over anything saved here.</div>
            </div>
          )}

          {status?.configured && (
            <div className="summary">
              <dl>
                <dt>Consumer key</dt>
                <dd className="mono">{status.maskedKey}</dd>
                <dt>Status</dt>
                <dd>Saved and verified</dd>
              </dl>
            </div>
          )}

          <form onSubmit={save}>
            <div className="field">
              <label htmlFor="ck">Consumer key</label>
              <input
                id="ck"
                type="text"
                autoComplete="off"
                value={consumerKey}
                disabled={status?.managedByEnv}
                onChange={(e) => setConsumerKey(e.target.value)}
                placeholder={status?.configured ? 'Enter a new key to replace the saved one' : 'Your Tonic API username'}
              />
            </div>
            <div className="field">
              <label htmlFor="cs">Consumer secret</label>
              <input
                id="cs"
                type="password"
                autoComplete="off"
                value={consumerSecret}
                disabled={status?.managedByEnv}
                onChange={(e) => setConsumerSecret(e.target.value)}
                placeholder={status?.configured ? 'Enter a new secret to replace the saved one' : 'Your Tonic API password'}
              />
            </div>

            <div className="toolbar">
              <button
                className="btn"
                type="submit"
                disabled={saving || status?.managedByEnv || !consumerKey.trim() || !consumerSecret.trim()}
              >
                {saving && <span className="spinner" />}
                {saving ? 'Verifying…' : 'Save and verify'}
              </button>

              {status?.configured && (
                <>
                  <button className="btn btn-secondary" type="button" onClick={test} disabled={testing}>
                    {testing && <span className="spinner" />}
                    {testing ? 'Testing…' : 'Test connection'}
                  </button>
                  {!status.managedByEnv && (
                    <button className="btn btn-danger" type="button" onClick={disconnect}>Remove</button>
                  )}
                </>
              )}
            </div>
          </form>
        </div>
      </div>
    </Layout>
  );
}
