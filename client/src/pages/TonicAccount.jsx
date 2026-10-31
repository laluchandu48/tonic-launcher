import { useCallback, useEffect, useState } from 'react';
import Layout from '../components/Layout.jsx';
import { useToast } from '../components/Toast.jsx';
import { api } from '../lib/api.js';

/**
 * The Tonic account: who you are, whether Tonic can reach your ad accounts,
 * and the API credentials you have issued.
 *
 * Three of the tabs from Tonic's own Settings screen, limited to what v4
 * exposes. Where it exposes nothing — connecting a business portfolio, or
 * listing the ones already connected — the page says so and links out rather
 * than showing a control that cannot work.
 */

const TABS = [
  { key: 'account', label: 'Account settings' },
  { key: 'network', label: 'Network access' },
  { key: 'api', label: 'API Credentials' },
];

const PROVIDERS = [
  { value: 'facebook', label: 'Facebook' },
  { value: 'tiktok', label: 'TikTok' },
];

const DURATIONS = [3, 6, 9, 12];

const day = (iso) => (iso ? String(iso).slice(0, 10) : '—');

/** How long until a credential expires, said the way a person would. */
function expiresIn(iso) {
  if (!iso) return { text: '—', tone: '' };
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return { text: '—', tone: '' };
  const days = Math.round((then - new Date()) / 86_400_000);
  if (days < 0) return { text: 'expired', tone: 'neg' };
  if (days === 0) return { text: 'today', tone: 'neg' };
  if (days < 31) return { text: `${days} day${days === 1 ? '' : 's'}`, tone: 'neg' };
  const months = Math.round(days / 30);
  return { text: `${months} month${months === 1 ? '' : 's'} (${day(iso)})`, tone: '' };
}

export default function TonicAccount() {
  const toast = useToast();
  const [tab, setTab] = useState('account');
  const [needsCredentials, setNeedsCredentials] = useState(false);

  // ── Account ──
  const [account, setAccount] = useState(null);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [errors, setErrors] = useState({});

  // ── Network access ──
  const [provider, setProvider] = useState('facebook');
  const [access, setAccess] = useState(null);
  const [accountIds, setAccountIds] = useState('');
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(null);

  // ── API credentials ──
  const [creds, setCreds] = useState([]);
  const [credsLoading, setCredsLoading] = useState(false);
  const [revealed, setRevealed] = useState({});
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: '', description: '', months: 3 });
  const [saving, setSaving] = useState(false);
  const [justCreated, setJustCreated] = useState(null);

  const loadAccount = useCallback(async () => {
    try {
      const a = await api.tonicAccount.get();
      setAccount(a);
      setFirstName(a.firstName || '');
      setLastName(a.lastName || '');
      setNeedsCredentials(false);
    } catch (err) {
      if (err.code === 'NO_CREDENTIALS') setNeedsCredentials(true);
      else toast.error(err.message);
    }
  }, []);

  useEffect(() => { loadAccount(); }, [loadAccount]);

  useEffect(() => {
    if (tab !== 'network') return;
    api.tonicAccount.managedAccess(provider)
      .then(setAccess)
      .catch((err) => { setAccess(null); toast.error(err.message); });
  }, [tab, provider]);

  const loadCreds = useCallback(async () => {
    setCredsLoading(true);
    try {
      const { rows } = await api.tonicAccount.apiCredentials();
      setCreds(rows || []);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setCredsLoading(false);
    }
  }, []);

  useEffect(() => { if (tab === 'api') loadCreds(); }, [tab, loadCreds]);

  const saveName = async () => {
    setSavingName(true);
    setErrors({});
    try {
      const a = await api.tonicAccount.patch({ firstName, lastName });
      setAccount(a);
      toast.success('Name updated.');
    } catch (err) {
      if (err.fields) setErrors(err.fields);
      toast.error(err.message);
    } finally {
      setSavingName(false);
    }
  };

  const check = async () => {
    setChecking(true);
    try {
      setChecked(await api.tonicAccount.checkAccounts(provider, accountIds));
    } catch (err) {
      toast.error(err.message);
      setChecked(null);
    } finally {
      setChecking(false);
    }
  };

  const reveal = async (id) => {
    try {
      const full = await api.tonicAccount.revealCredential(id);
      setRevealed((r) => ({ ...r, [id]: full }));
    } catch (err) {
      toast.error(err.message);
    }
  };

  const copy = (text, what) => {
    navigator.clipboard?.writeText(text)
      .then(() => toast.success(`${what} copied.`))
      .catch(() => toast.error('Could not copy.'));
  };

  const createCredential = async () => {
    setSaving(true);
    setErrors({});
    try {
      const res = await api.tonicAccount.createCredential(draft);
      setJustCreated(res);
      setCreating(false);
      setDraft({ name: '', description: '', months: 3 });
      loadCreds();
    } catch (err) {
      if (err.fields) setErrors(err.fields);
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const removeCredential = async (c) => {
    try {
      await api.tonicAccount.deleteCredential(c.id);
      toast.success(`${c.name || 'Credential'} deleted.`);
      setCreds((rows) => rows.filter((r) => r.id !== c.id));
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (needsCredentials) {
    return (
      <Layout title="Tonic account">
        <div className="banner banner-warn">
          <span>⚠</span>
          <div>Tonic credentials are not configured yet. Add them on Launcher settings first.</div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout title="Tonic account">
      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`tab ${tab === t.key ? 'on' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Account settings ── */}
      {tab === 'account' && (
        <>
          <div className="card">
            <div className="card-head"><h2>Your details</h2></div>
            <div className="card-body">
              <div className="field">
                <label htmlFor="firstName">First name</label>
                <input
                  id="firstName"
                  value={firstName}
                  className={errors.firstName ? 'invalid' : ''}
                  onChange={(e) => setFirstName(e.target.value)}
                />
                {errors.firstName && <p className="error-text">{errors.firstName}</p>}
              </div>
              <div className="field">
                <label htmlFor="lastName">Last name</label>
                <input
                  id="lastName"
                  value={lastName}
                  className={errors.lastName ? 'invalid' : ''}
                  onChange={(e) => setLastName(e.target.value)}
                />
                {errors.lastName && <p className="error-text">{errors.lastName}</p>}
              </div>
              <button className="btn" onClick={saveName} disabled={savingName}>
                {savingName && <span className="spinner" />}
                {savingName ? 'Saving…' : 'Save'}
              </button>
              <p className="hint" style={{ marginTop: 10 }}>
                Name is the only thing Tonic's API lets this screen change. Everything below is
                read-only here — change it in Tonic's own settings.
              </p>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h2>Account</h2></div>
            <div className="card-body">
              <dl className="detail-list">
                <dt>Email</dt><dd>{account?.email || '—'}</dd>
                <dt>Network</dt><dd>{account?.network || '—'}</dd>
                <dt>Role</dt>
                <dd>{account?.isSubUser ? (account.subUserRole || 'Sub-user') : 'Account owner'}</dd>
                <dt>Campaign types</dt>
                <dd>{account?.availableCampaignTypes?.join(', ') || '—'}</dd>
                <dt>Remaining campaigns</dt>
                <dd>
                  {account && Object.keys(account.remainingCampaigns || {}).length
                    ? Object.entries(account.remainingCampaigns)
                        .map(([k, v]) => `${k}: ${v}`).join(' · ')
                    : '—'}
                </dd>
                <dt>RSOC domains</dt>
                <dd>{account?.rsocDomains?.length ? account.rsocDomains.join(', ') : '—'}</dd>
              </dl>
            </div>
          </div>
        </>
      )}

      {/* ── Network access ── */}
      {tab === 'network' && (
        <>
          <div className="card">
            <div className="card-head" style={{ flexWrap: 'wrap', gap: 10 }}>
              <h2>Managed access</h2>
              <select
                value={provider}
                onChange={(e) => { setProvider(e.target.value); setChecked(null); }}
                style={{ width: 'auto' }}
                aria-label="Provider"
              >
                {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            <div className="card-body">
              <p>
                {access == null ? 'Checking…' : access.connected ? (
                  <>
                    <span className="badge badge-ok">Connected</span>{' '}
                    Tonic holds {PROVIDERS.find((p) => p.value === provider)?.label} credentials
                    for this account.
                  </>
                ) : (
                  <>
                    <span className="badge badge-bad">Not connected</span>{' '}
                    Tonic has no {PROVIDERS.find((p) => p.value === provider)?.label} credentials
                    for this account, so it cannot see your ad accounts or auto-pause
                    non-compliant ads.
                  </>
                )}
              </p>
              <p className="hint">
                Connecting a business portfolio is a sign-in handled on Tonic's own site and has
                no API behind it, so it cannot be done from here — use{' '}
                <a className="link" href="https://publisher.tonic.com/settings/network"
                   target="_blank" rel="noreferrer">
                  Tonic → Settings → Network access ↗
                </a>. Once connected, check it below.
              </p>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Check whether Tonic has access to your accounts</h2>
            </div>
            <div className="card-body">
              <div className="field">
                <label htmlFor="accountIds">Ad account IDs</label>
                <textarea
                  id="accountIds"
                  rows={4}
                  value={accountIds}
                  placeholder="e.g. 123456789, act_987654321"
                  onChange={(e) => setAccountIds(e.target.value)}
                />
                <p className="hint">
                  Up to 10 accounts, separated by comma, space or new line. It can take a few
                  hours after connecting an account before it shows here.
                </p>
              </div>
              <button className="btn" onClick={check} disabled={checking || !accountIds.trim()}>
                {checking && <span className="spinner" />}
                {checking ? 'Checking…' : 'Check accounts'}
              </button>
            </div>

            {checked?.results?.length > 0 && (
              <div className="table-scroll" style={{ '--table-min': '620px' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Account ID</th>
                      <th>Status</th>
                      <th>Explanation</th>
                      <th>Last checked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {checked.results.map((r) => (
                      <tr key={r.accountId}>
                        <td className="mono">{r.accountId}</td>
                        <td>
                          {r.error ? <span className="badge badge-bad">error</span>
                            : <span className={`badge ${r.state === 'connected' ? 'badge-ok' : 'badge-idle'}`}>
                                {r.state || 'unknown'}
                              </span>}
                        </td>
                        <td className="muted">{r.error || r.explanation || '—'}</td>
                        <td className="muted">{r.lastUpdate ? r.lastUpdate.slice(0, 16).replace('T', ' ') : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── API credentials ── */}
      {tab === 'api' && (
        <div className="card">
          <div className="card-head">
            <h2>API Credentials</h2>
            <div className="toolbar">
              <button className="btn btn-secondary" onClick={loadCreds} disabled={credsLoading}>
                {credsLoading && <span className="spinner" />}
                {credsLoading ? 'Loading…' : 'Refresh'}
              </button>
              <button className="btn" onClick={() => setCreating(true)}>+ API Credential</button>
            </div>
          </div>

          {justCreated && (
            <div className="banner banner-warn" style={{ margin: 16 }}>
              <span>⚠</span>
              <div>
                <strong>Copy the secret now.</strong> This is the only time it is shown in full.
                <dl className="detail-list" style={{ marginTop: 8 }}>
                  <dt>Consumer key</dt>
                  <dd className="mono" style={{ wordBreak: 'break-all' }}>
                    {justCreated.secretOnce.consumerKey}
                    <button className="btn btn-ghost" onClick={() => copy(justCreated.secretOnce.consumerKey, 'Key')}>Copy</button>
                  </dd>
                  <dt>Consumer secret</dt>
                  <dd className="mono" style={{ wordBreak: 'break-all' }}>
                    {justCreated.secretOnce.consumerSecret}
                    <button className="btn btn-ghost" onClick={() => copy(justCreated.secretOnce.consumerSecret, 'Secret')}>Copy</button>
                  </dd>
                </dl>
                <button className="btn btn-secondary" onClick={() => setJustCreated(null)}>Done</button>
              </div>
            </div>
          )}

          {creating && (
            <div className="card-body" style={{ borderBottom: '1px solid var(--line)' }}>
              <div className="field">
                <label htmlFor="credName">Name</label>
                <input
                  id="credName"
                  value={draft.name}
                  className={errors.name ? 'invalid' : ''}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                />
                {errors.name && <p className="error-text">{errors.name}</p>}
              </div>
              <div className="field">
                <label htmlFor="credDesc">Description</label>
                <input
                  id="credDesc"
                  value={draft.description}
                  onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                />
              </div>
              <div className="field">
                <label htmlFor="credMonths">Duration</label>
                <select
                  id="credMonths"
                  value={draft.months}
                  onChange={(e) => setDraft((d) => ({ ...d, months: Number(e.target.value) }))}
                  style={{ width: 'auto' }}
                >
                  {DURATIONS.map((m) => <option key={m} value={m}>{m} months</option>)}
                </select>
              </div>
              <div className="toolbar">
                <button className="btn" onClick={createCredential} disabled={saving}>
                  {saving && <span className="spinner" />}
                  {saving ? 'Creating…' : 'Save'}
                </button>
                <button className="btn btn-ghost" onClick={() => setCreating(false)}>Cancel</button>
              </div>
            </div>
          )}

          {credsLoading ? (
            <div className="empty">Loading…</div>
          ) : creds.length === 0 ? (
            <div className="empty"><p>No API credentials yet.</p></div>
          ) : (
            <div className="table-scroll" style={{ '--table-min': '860px' }}>
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Expires in</th>
                    <th>Consumer Key</th>
                    <th>Consumer Secret</th>
                    <th>Description</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {creds.map((c) => {
                    const exp = expiresIn(c.validUntil);
                    const full = revealed[c.id];
                    return (
                      <tr key={c.id}>
                        <td>{c.name || '—'}</td>
                        <td className={exp.tone}>{exp.text}</td>
                        <td className="mono" style={{ wordBreak: 'break-all' }}>
                          {full ? full.consumerKey : c.consumerKeyMasked || '—'}
                        </td>
                        <td className="mono" style={{ wordBreak: 'break-all' }}>
                          {full ? full.consumerSecret : c.consumerSecretMasked || '—'}
                        </td>
                        <td className="muted">{c.description || '—'}</td>
                        <td>
                          <div className="toolbar">
                            {full ? (
                              <button className="btn btn-ghost"
                                      onClick={() => copy(full.consumerSecret, 'Secret')}>
                                Copy secret
                              </button>
                            ) : (
                              <button className="btn btn-ghost" onClick={() => reveal(c.id)}>
                                Reveal
                              </button>
                            )}
                            <button className="btn btn-ghost" onClick={() => removeCredential(c)}>
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <p className="hint" style={{ padding: '0 18px 18px' }}>
            Keys and secrets are hidden until you ask for them, and only fetched from Tonic at
            that moment — a secret left on screen ends up in screenshots.
          </p>
        </div>
      )}
    </Layout>
  );
}
