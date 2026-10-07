import { useState } from 'react';
import PasswordInput from '../components/PasswordInput.jsx';
import { api } from '../lib/api.js';

/**
 * Deliberately plain. The one job is to not get in the way, and to say exactly
 * one thing when it fails — the server does not distinguish a wrong username
 * from a wrong password, and neither should this.
 */
export default function Login({ onSignedIn }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { user } = await api.auth.login(username.trim(), password);
      onSignedIn(user);
    } catch (err) {
      setError(err.message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-shell">
      <form className="card login-card" onSubmit={submit}>
        <div className="brand" style={{ marginBottom: 4 }}>TONIC.</div>
        <p className="hint" style={{ marginBottom: 20 }}>Launcher</p>

        <div className="field">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            type="text"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <PasswordInput
            id="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {error && <p className="error-text" style={{ marginBottom: 12 }}>{error}</p>}

        <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy && <span className="spinner" />}
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
