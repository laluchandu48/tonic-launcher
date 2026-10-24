import { NavLink } from 'react-router-dom';

/**
 * Overview / Keywords, the two faces of the Campaigns screen.
 *
 * Both are campaign data, so they share one entry in the sidebar rather than
 * each claiming their own — the same arrangement Tonic uses, which also means
 * switching between them does not look like leaving the page you were on.
 */
export default function CampaignTabs() {
  return (
    <div className="tabs">
      <NavLink to="/campaigns" end className={({ isActive }) => (isActive ? 'tab on' : 'tab')}>
        Overview
      </NavLink>
      <NavLink to="/campaigns/keywords" className={({ isActive }) => (isActive ? 'tab on' : 'tab')}>
        Keywords
      </NavLink>
    </div>
  );
}
