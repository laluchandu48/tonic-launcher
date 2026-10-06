import { Routes, Route } from 'react-router-dom';
import { ToastProvider } from './components/Toast.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Articles from './pages/Articles.jsx';
import Campaigns from './pages/Campaigns.jsx';
import CampaignDetail from './pages/CampaignDetail.jsx';
import Compliance from './pages/Compliance.jsx';
import FinalData from './pages/FinalData.jsx';
import FbSettings from './pages/FbSettings.jsx';
import Settings from './pages/Settings.jsx';

export default function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/articles" element={<Articles />} />
        <Route path="/campaigns" element={<Campaigns />} />
        <Route path="/campaigns/:id" element={<CampaignDetail />} />
        <Route path="/compliance" element={<Compliance />} />
        <Route path="/final-data" element={<FinalData />} />
        <Route path="/fb-settings" element={<FbSettings />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </ToastProvider>
  );
}
