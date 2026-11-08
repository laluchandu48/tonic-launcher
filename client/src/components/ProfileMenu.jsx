import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession } from './SessionContext.jsx';

/**
 * The signed-in user, top right, with everything about the account behind it.
 *
 * Settings used to sit in the left sidebar beside Campaigns and Articles,
 * which put "change my password" at the same level as "today's spend". They
 * are different kinds of thing: one is the work, the other is the account. The
 * sidebar is now only the work.
 */

const initialsOf = (name) => {
  const text = String(name || '').trim();
  if (!text) return '·';
  const parts = text.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1
    ? `${parts[0][0]}${parts[parts.length - 1][0]}`
    : text.slice(0, 2);
  return letters.toUpperCase();
};

export default function ProfileMenu() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const user = useSession();
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const go = (to) => { setOpen(false); navigate(to); };

  const signOut = async () => {
    setOpen(false);
    try { await api.auth.logout(); } catch { /* the reload signs out regardless */ }
    // The app decides what to show from its own session check, so a reload is
    // the simplest way back to the sign-in screen without duplicating that.
    window.location.assign('/');
  };

  const name = user?.email || user?.username || '';
  /* A viewer has no settings to reach, so the menu is just their password and
     the way out. The server refuses those routes anyway; offering them would
     only produce an error with extra steps. */
  const isAdmin = user?.role !== 'viewer';

  return (
    <div className="profile" ref={ref}>
      <button
        type="button"
        className="profile-button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={name ? `Signed in as ${name}` : 'Account'}
      >
        <span className="profile-name">{name}</span>
        <span className="profile-avatar" aria-hidden="true">{initialsOf(name)}</span>
      </button>

      {open && (
        <div className="profile-menu" role="menu">
          <div className="profile-head">
            <strong>{name || 'Signed in'}</strong>
            <span className="muted">
              {user?.role === 'viewer' ? 'Final Data access' : 'Tonic Launcher'}
            </span>
          </div>

          {isAdmin && (
            <>
              <button type="button" className="profile-item" onClick={() => go('/users')}>
                Users
                <span className="muted">Who can sign in, and what they can see</span>
              </button>
              <button type="button" className="profile-item" onClick={() => go('/tonic-account')}>
                Tonic account
                <span className="muted">Account, network access, API credentials</span>
              </button>
              <button type="button" className="profile-item" onClick={() => go('/settings')}>
                Launcher settings
                <span className="muted">Tonic API credentials used by this app</span>
              </button>
              <button type="button" className="profile-item" onClick={() => go('/fb-settings')}>
                FB settings
                <span className="muted">Access token and dashboard ad accounts</span>
              </button>
            </>
          )}
          <button type="button" className="profile-item" onClick={() => go('/account')}>
            Change password
          </button>

          <button type="button" className="profile-item profile-signout" onClick={signOut}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
