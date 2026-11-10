import { useCallback, useEffect, useState } from 'react';
import Layout from '../components/Layout.jsx';
import { useToast } from '../components/Toast.jsx';
import { api } from '../lib/api.js';
import { useSession } from '../components/SessionContext.jsx';

/**
 * The three levels, in the order they are offered: least access first, so
 * the safe choice is the one already selected.
 *
 * The labels are short because a dropdown is a bad place for a sentence —
 * the long one got clipped in the list. What each level means goes in the
 * hint under the field, where there is room for it.
 */
const LEVELS = [
  { value: 'viewer', label: 'Read-only',
    hint: 'Sees Final Data for the ad accounts you assign. Changes nothing.' },
  { value: 'editor', label: 'Can edit',
    hint: 'The same screen, plus the budget and on/off controls — on their own ad accounts only.' },
  { value: 'admin', label: 'Admin',
    hint: 'Everything you can do, including the Tonic and Facebook credentials. All ad accounts.' },
];
const levelLabel = (role) => LEVELS.find((l) => l.value === role)?.label || role;

/**
 * Who can sign in, and what they can see.
 *
 * Three levels. Read-only and "can edit" both get Final Data for the ad
 * accounts ticked here and nothing else — no settings, no API credentials —
 * and differ only in whether the budget and on/off controls work. An admin
 * gets everything. The restriction lives on the server; this screen sets it.
 *
 * There is no mail server behind this app, so a new user's password appears
 * here once and you pass it on yourself. It is not recoverable afterwards:
 * only its hash is stored, which is the point.
 */
export default function Users() {
  const toast = useToast();
  const me = useSession();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState([]);

  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('viewer');
  const [picked, setPicked] = useState(() => new Set());
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});

  /** The one-time password, kept on screen until it is dismissed. */
  const [issued, setIssued] = useState(null);

  const [editing, setEditing] = useState(null);
  const [editPicked, setEditPicked] = useState(() => new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { rows: list } = await api.users.list();
      setRows(list || []);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.fbSettings.accounts()
      .then(({ accounts: list }) => setAccounts(list || []))
      .catch(() => { /* the picker simply stays empty, and says so */ });
  }, []);

  const nameOf = (id) => accounts.find((a) => a.id === id)?.name || id;

  const toggle = (set, setter) => (id) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    setter(next);
  };

  const create = async () => {
    setSaving(true);
    setErrors({});
    try {
      const res = await api.users.create({ email, role, adAccounts: [...picked] });
      setIssued({ email: res.user.email, password: res.temporaryPassword, isNew: true });
      setAdding(false);
      setEmail('');
      setRole('viewer');
      setPicked(new Set());
      load();
    } catch (err) {
      if (err.fields) setErrors(err.fields);
      else toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const saveAccounts = async (user) => {
    try {
      await api.users.update(user.id, { adAccounts: [...editPicked] });
      toast.success(`Ad accounts updated for ${user.email || user.username}.`);
      setEditing(null);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const setLevel = async (user, next) => {
    try {
      await api.users.update(user.id, { role: next });
      toast.success(`${user.email || user.username} is now ${levelLabel(next).toLowerCase()}.`);
      load();
    } catch (err) {
      toast.error(err.message);
      load();   // put the dropdown back to what the server still says
    }
  };

  const setActive = async (user, active) => {
    try {
      await api.users.update(user.id, { active });
      toast.success(active ? 'Account restored.' : 'Account suspended.');
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const resetPassword = async (user) => {
    try {
      const res = await api.users.resetPassword(user.id);
      setIssued({ email: user.email || user.username, password: res.temporaryPassword, isNew: false });
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const remove = async (user) => {
    try {
      await api.users.remove(user.id);
      toast.success('User deleted.');
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const copy = (text) => {
    navigator.clipboard?.writeText(text)
      .then(() => toast.success('Password copied.'))
      .catch(() => toast.error('Could not copy.'));
  };

  const AccountPicker = ({ set, onToggle }) => (
    accounts.length === 0 ? (
      <p className="hint">
        No ad accounts are reachable with the current Facebook token, so there is nothing to
        assign yet.
      </p>
    ) : (
      <div className="account-picks">
        {accounts.map((a) => (
          <label className="account-pick" key={a.id}>
            <input type="checkbox" checked={set.has(a.id)} onChange={() => onToggle(a.id)} />
            <span>
              {a.name}
              <span className="muted mono" style={{ display: 'block', fontSize: 11 }}>
                {a.id}{a.currency ? ` · ${a.currency}` : ''}{a.active ? '' : ' · inactive'}
              </span>
            </span>
          </label>
        ))}
      </div>
    )
  );

  return (
    <Layout
      title="Users"
      actions={<button className="btn" onClick={() => setAdding(true)}>Add user</button>}
    >
      {issued && (
        <div className="banner banner-warn">
          <span>⚠</span>
          <div>
            <strong>
              {issued.isNew ? 'User created.' : 'Password reset.'} Copy this password now —
              it is not shown again.
            </strong>
            <dl className="detail-list" style={{ marginTop: 8 }}>
              <dt>Sign in with</dt>
              <dd className="mono">{issued.email}</dd>
              <dt>Temporary password</dt>
              <dd className="mono">
                {issued.password}
                <button className="btn btn-ghost" onClick={() => copy(issued.password)}>Copy</button>
              </dd>
            </dl>
            <p className="hint">
              They will be asked to choose their own password the first time they sign in.
            </p>
            <button className="btn btn-secondary" onClick={() => setIssued(null)}>Done</button>
          </div>
        </div>
      )}

      {adding && (
        <div className="card">
          <div className="card-head"><h2>Add a user</h2></div>
          <div className="card-body">
            <div className="field">
              <label htmlFor="email">Email address</label>
              <input
                id="email"
                type="email"
                value={email}
                className={errors.email ? 'invalid' : ''}
                placeholder="name@company.com"
                onChange={(e) => setEmail(e.target.value)}
              />
              {errors.email && <p className="error-text">{errors.email}</p>}
              <p className="hint">This is what they sign in with. A password is generated for them.</p>
            </div>

            <div className="field">
              <label htmlFor="level">Access</label>
              {/* Narrow on purpose: a full-width select makes a dropdown as
                  wide as the card, and the list was being clipped. */}
              <select
                id="level"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                style={{ maxWidth: 260 }}
              >
                {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
              <p className="hint">{LEVELS.find((l) => l.value === role)?.hint}</p>
            </div>

            <div className="field" style={{ display: role === 'admin' ? 'none' : undefined }}>
              <label>Ad accounts they can see</label>
              <AccountPicker set={picked} onToggle={toggle(picked, setPicked)} />
              <p className="hint">
                {picked.size} selected. With none ticked they can sign in but will see nothing,
                which is a reasonable way to add someone before deciding.
              </p>
            </div>

            <div className="toolbar">
              <button className="btn" onClick={create} disabled={saving || !email.trim()}>
                {saving && <span className="spinner" />}
                {saving ? 'Creating…' : 'Create user'}
              </button>
              <button className="btn btn-ghost" onClick={() => { setAdding(false); setErrors({}); }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>People</h2>
          <button className="btn btn-secondary" onClick={load} disabled={loading}>
            {loading && <span className="spinner" />}
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {loading ? (
          <div className="empty">Loading…</div>
        ) : (
          <div className="table-scroll" style={{ '--table-min': '860px' }}>
            <table>
              <thead>
                <tr>
                  <th>Sign in</th>
                  <th>Role</th>
                  <th>Ad accounts</th>
                  <th>Status</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.email || u.username}
                      {u.mustChange && (
                        <div className="muted" style={{ fontSize: 11 }}>
                          has not set their own password yet
                        </div>
                      )}
                    </td>
                    <td>
                      {u.id === me?.id ? (
                        /* Your own level is not yours to lower — the server
                           refuses it, and a dropdown that always errors is
                           worse than no dropdown. */
                        <span className="badge badge-ok" title="Your own account">{u.role}</span>
                      ) : (
                        <select
                          value={u.role}
                          onChange={(e) => setLevel(u, e.target.value)}
                          aria-label={`Access for ${u.email || u.username}`}
                          title={LEVELS.find((l) => l.value === u.role)?.hint}
                          style={{ maxWidth: 160 }}
                        >
                          {LEVELS.map((l) => (
                            <option key={l.value} value={l.value}>{l.label}</option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td>
                      {u.role === 'admin' ? (
                        <span className="muted">all</span>
                      ) : u.adAccounts.length === 0 ? (
                        <span className="muted">none assigned</span>
                      ) : (
                        <span title={u.adAccounts.map(nameOf).join(', ')}>
                          {u.adAccounts.length} account{u.adAccounts.length === 1 ? '' : 's'}
                          <span className="muted" style={{ fontSize: 11, display: 'block' }}>
                            {u.adAccounts.slice(0, 2).map(nameOf).join(', ')}
                            {u.adAccounts.length > 2 && ` +${u.adAccounts.length - 2}`}
                          </span>
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${u.active ? 'badge-ok' : 'badge-bad'}`}>
                        {u.active ? 'active' : 'suspended'}
                      </span>
                    </td>
                    <td>
                      <div className="toolbar">
                        {u.role !== 'admin' && (
                          <button
                            className="btn btn-ghost"
                            onClick={() => { setEditing(u); setEditPicked(new Set(u.adAccounts)); }}
                          >
                            Ad accounts
                          </button>
                        )}
                        <button className="btn btn-ghost" onClick={() => resetPassword(u)}>
                          Reset password
                        </button>
                        <button className="btn btn-ghost" onClick={() => setActive(u, !u.active)}>
                          {u.active ? 'Suspend' : 'Restore'}
                        </button>
                        <button className="btn btn-ghost" onClick={() => remove(u)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <div className="card">
          <div className="card-head">
            <h2>Ad accounts for {editing.email || editing.username}</h2>
          </div>
          <div className="card-body">
            <AccountPicker set={editPicked} onToggle={toggle(editPicked, setEditPicked)} />
            <div className="toolbar" style={{ marginTop: 12 }}>
              <button className="btn" onClick={() => saveAccounts(editing)}>Save</button>
              <button className="btn btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
              <span className="muted" style={{ fontSize: 12 }}>{editPicked.size} selected</span>
            </div>
          </div>
        </div>
      )}

      <div className="footnotes">
        <p className="note">
          Read-only and "can edit" both see Final Data for the accounts assigned to them and
          nothing else — no settings and no API credentials. "Can edit" adds the budget and
          on/off controls, and only for adsets in their own ad accounts. Suspending someone ends
          their session immediately.
        </p>
      </div>
    </Layout>
  );
}
