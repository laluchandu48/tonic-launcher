import { useCallback, useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { ToastProvider } from './components/Toast.jsx';
import { api } from './lib/api.js';
import Dashboard from './pages/Dashboard.jsx';
import Articles from './pages/Articles.jsx';
import Campaigns from './pages/Campaigns.jsx';
import CampaignDetail from './pages/CampaignDetail.jsx';
import Keywords from './pages/Keywords.jsx';
import Compliance from './pages/Compliance.jsx';
import FinalData from './pages/FinalData.jsx';
import AdsetHistory from './pages/AdsetHistory.jsx';
import FbSettings from './pages/FbSettings.jsx';
import Settings from './pages/Settings.jsx';
import Login from './pages/Login.jsx';
import Account from './pages/Account.jsx';
import TonicAccount from './pages/TonicAccount.jsx';
import Users from './pages/Users.jsx';

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);

  // One call on load decides whether to show the app or the sign-in screen.
  // Until it answers, neither is rendered — flashing a login form at someone
  // who is already signed in is worse than a blank moment.
  useEffect(() => {
    api.auth.me()
      .then(({ user: u }) => setUser(u))
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, []);

  // Any 401 from anywhere in the app lands here, so an expired session shows
  // the sign-in screen rather than a wall of failed requests.
  const onUnauthorised = useCallback(() => setUser(null), []);
  useEffect(() => {
    window.addEventListener('tl:unauthorised', onUnauthorised);
    return () => window.removeEventListener('tl:unauthorised', onUnauthorised);
  }, [onUnauthorised]);

  if (checking) return null;

  if (!user) {
    return (
      <ToastProvider>
        <Login onSignedIn={setUser} />
      </ToastProvider>
    );
  }

  /* A first-time password has to be changed before anything else. Everything
     routes to Account until it is — the server still enforces its own rules,
     but nobody should be using a password an admin can read off a screen. */
  if (user.mustChange) {
    return (
      <ToastProvider>
        <Routes>
          <Route path="*" element={<Account user={user} onSignedOut={() => setUser(null)} />} />
        </Routes>
      </ToastProvider>
    );
  }

  /* A viewer has one screen. The server refuses the rest regardless; this
     keeps the app from offering doors that only lead to an error. */
  if (user.role === 'viewer') {
    return (
      <ToastProvider>
        <Routes>
          <Route path="/final-data" element={<FinalData />} />
          <Route path="/final-data/adsets/:id" element={<AdsetHistory />} />
          <Route path="/account" element={<Account user={user} onSignedOut={() => setUser(null)} />} />
          <Route path="*" element={<Navigate to="/final-data" replace />} />
        </Routes>
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/users" element={<Users />} />
        <Route path="/articles" element={<Articles />} />
        <Route path="/campaigns" element={<Campaigns />} />
        <Route path="/campaigns/keywords" element={<Keywords />} />
        <Route path="/campaigns/:id" element={<CampaignDetail />} />
        <Route path="/compliance" element={<Compliance />} />
        <Route path="/final-data" element={<FinalData />} />
        <Route path="/final-data/adsets/:id" element={<AdsetHistory />} />
        <Route path="/fb-settings" element={<FbSettings />} />
        <Route path="/tonic-account" element={<TonicAccount />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/account" element={<Account user={user} onSignedOut={() => setUser(null)} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ToastProvider>
  );
}
