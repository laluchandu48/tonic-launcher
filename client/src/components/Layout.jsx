import { NavLink } from 'react-router-dom';
import ThemeToggle from './ThemeToggle.jsx';
import ProfileMenu from './ProfileMenu.jsx';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

const NAV = [
  { to: '/',          label: 'Dashboard', icon: '▦', end: true },
  { to: '/articles',  label: 'Articles',  icon: '☰' },
  { to: '/campaigns', label: 'Campaigns', icon: '◪' },
  { to: '/final-data', label: 'Final Data', icon: '⇄' },
  { to: '/compliance', label: 'Compliance', icon: '⛨' },
];

/* Settings used to sit here beside Campaigns and Articles, which put "change
   my password" at the same level as "today's spend". They are different kinds
   of thing, so the sidebar is the work and the profile menu is the account. */

export default function Layout({ title, tools, actions, children }) {
  /* The sidebar is built from the signed-in role: a viewer reaches only Final
     Data, so showing them the rest would be a menu of locked doors. */
  const [role, setRole] = useState(null);
  useEffect(() => {
    api.auth.me().then(({ user }) => setRole(user?.role || null)).catch(() => {});
  }, []);
  const nav = role === 'viewer' ? NAV.filter((i) => i.to === '/final-data') : NAV;

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">TONIC.</div>
        <div className="nav">
          {nav.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end}>
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </div>
        <div className="sidebar-foot">
          <strong>Launcher</strong>
          Campaigns via the Publisher API
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <h1>{title}</h1>
          {/* Page-specific controls sit to the right, the way an analytics
              tool puts its account and date pickers — out of the content,
              always in the same place. */}
          <div className="topbar-tools">
            {tools}
            <ThemeToggle />
            {actions}
            <ProfileMenu />
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
