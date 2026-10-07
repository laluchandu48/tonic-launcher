import { useState } from 'react';
import Layout from '../components/Layout.jsx';
import { useToast } from '../components/Toast.jsx';
import PasswordInput from '../components/PasswordInput.jsx';
import { api } from '../lib/api.js';

const MIN_LENGTH = 8;

export default function Account({ user, onSignedOut }) {
  const toast = useToast();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const next = {};
    if (!currentPassword) next.currentPassword = 'Enter your current password.';
    if (newPassword.length < MIN_LENGTH) next.newPassword = `At least ${MIN_LENGTH} characters.`;
    if (newPassword !== confirm) next.confirm = 'The two do not match.';
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    try {
      await api.auth.changePassword(currentPassword, newPassword);
      setCurrentPassword(''); setNewPassword(''); setConfirm('');
      toast.success('Password changed.');
    } catch (err) {
      if (err.fields) setErrors(err.fields);
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    try {
      await api.auth.logout();
      onSignedOut();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <Layout
      title="Account"
      actions={<button className="btn btn-secondary" onClick={signOut}>Sign out</button>}
    >
      {user?.mustChange && (
        <div className="banner banner-warn">
          <span>⚠</span>
          <div>You are still using the password this account was created with. Change it below.</div>
        </div>
      )}

      <div className="card">
        <div className="card-head"><h2>Change password</h2></div>

        <div style={{ padding: 16, display: 'grid', gap: 16, maxWidth: 420 }}>
          <div className="field">
            <label htmlFor="current">Current password</label>
            <PasswordInput
              id="current"
              autoComplete="current-password"
              className={errors.currentPassword ? 'invalid' : ''}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
            {errors.currentPassword && <p className="error-text">{errors.currentPassword}</p>}
          </div>

          <div className="field">
            <label htmlFor="next">New password</label>
            <p className="hint">At least {MIN_LENGTH} characters.</p>
            <PasswordInput
              id="next"
              autoComplete="new-password"
              className={errors.newPassword ? 'invalid' : ''}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            {errors.newPassword && <p className="error-text">{errors.newPassword}</p>}
          </div>

          <div className="field">
            <label htmlFor="confirm">Repeat new password</label>
            <PasswordInput
              id="confirm"
              autoComplete="new-password"
              className={errors.confirm ? 'invalid' : ''}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {errors.confirm && <p className="error-text">{errors.confirm}</p>}
          </div>

          <div>
            <button className="btn" onClick={submit} disabled={busy}>
              {busy && <span className="spinner" />}
              {busy ? 'Saving…' : 'Change password'}
            </button>
          </div>

          <p className="hint">
            Signed in as <strong>{user?.username}</strong>. Changing your password signs out
            any other browser that was using this account.
          </p>
        </div>
      </div>
    </Layout>
  );
}
