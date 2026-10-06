import { NavLink } from 'react-router-dom';

const NAV = [
  { to: '/',          label: 'Dashboard', icon: '▦', end: true },
  { to: '/articles',  label: 'Articles',  icon: '☰' },
  { to: '/campaigns', label: 'Campaigns', icon: '◪' },
  { to: '/final-data', label: 'Final Data', icon: '⇄' },
  { to: '/compliance', label: 'Compliance', icon: '⛨' },
  { to: '/fb-settings', label: 'FB Settings', icon: 'ƒ' },
  { to: '/settings',  label: 'Settings',  icon: '⚙' },
];

export default function Layout({ title, actions, children }) {
  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">TONIC.</div>
        <div className="nav">
          {NAV.map((item) => (
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
          <div>{actions}</div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
