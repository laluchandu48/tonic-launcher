import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Layout from '../components/Layout.jsx';
import { useToast } from '../components/Toast.jsx';
import { api } from '../lib/api.js';

/** Order and labels follow the Tonic dashboard's own callback list. */
// v4 names these in camelCase; v3's snake_case keys are gone.
const CALLBACK_FIELDS = [
  { key: 'redirect', label: 'Redirect', hint: 'Fired when the visitor is redirected to the article.' },
  { key: 'view', label: 'View', hint: 'Fired when the keyword page is viewed.' },
  { key: 'viewRt', label: 'Viewrt', hint: 'Related-term click. Carries {keyword}.' },
  { key: 'click', label: 'Click', hint: 'Fired on an ad click. Carries {keyword}.' },
  { key: 'preEstimatedRevenue', label: 'Pre-Estimated Revenue', hint: 'Earliest revenue signal, sent immediately.' },
  { key: 'estimatedRevenue', label: 'Estimated Revenue', hint: 'Estimate available roughly 20 minutes to 2 hours after the click.' },
  { key: 'estimatedRevenue5h', label: 'Estimated Revenue 5h', hint: 'Revised estimate about five hours later.' },
];

const PLACEHOLDERS = ['{campaign_id}', '{campaign_name}', '{type}', '{timestamp}', '{device}', '{keyword}', '{event_id}', '{revenue}', '{currency}'];
const LOCATION_PARAMS = ['{city}', '{in city}', '{country}', '{in country}', '{state}', '{in state}'];

const KEYWORD_MIN = 3;
const KEYWORD_MAX = 10;

export default function CampaignDetail() {
  const { id } = useParams();
  const toast = useToast();

  const [campaign, setCampaign] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  const [amount, setAmount] = useState(6);
  const [keywords, setKeywords] = useState([]);
  const [savingKeywords, setSavingKeywords] = useState(false);

  const [callbacks, setCallbacks] = useState({});
  const [savedCallbacks, setSavedCallbacks] = useState({});
  const [callbackErrors, setCallbackErrors] = useState({});
  const [savingCallbacks, setSavingCallbacks] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // The list endpoint is the only place carrying offer/vertical/direct link,
      // so find this campaign in it rather than inventing a detail endpoint.
      try {
        const result = await api.campaigns.list('pending,active,stopped,deleted', { campaignIds: id });
        const found = (result.rows || [])[0];
        if (found && !cancelled) setCampaign({ ...found, state: found.status });
      } catch (err) {
        if (!cancelled) toast.error(err.message);
      }

      const settle = (promise, onOk) =>
        promise.then((v) => { if (!cancelled) onOk(v); })
               .catch((err) => { if (!cancelled) toast.error(err.message); });

      await Promise.all([
        settle(api.campaigns.status(id), setStatus),
        settle(api.campaigns.keywords.get(id), (kw) => {
          setAmount(kw.amount || 6);
          setKeywords(kw.keywords || []);
        }),
        settle(api.campaigns.callbacks.get(id), (cb) => {
          setCallbacks(cb.callbacks);
          setSavedCallbacks(cb.callbacks);
        }),
      ]);

      if (!cancelled) setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [id]);

  const saveKeywords = async () => {
    setSavingKeywords(true);
    try {
      const filled = keywords.map((k) => (k || '').trim()).filter(Boolean);
      const result = await api.campaigns.keywords.save(id, amount, filled);
      setKeywords(result.keywords || filled);
      toast.success(
        filled.length < amount
          ? `Saved. Tonic will fill the remaining ${amount - filled.length} slot${amount - filled.length === 1 ? '' : 's'} with its own suggestions.`
          : 'Keywords saved.'
      );
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingKeywords(false);
    }
  };

  const saveCallbacks = async () => {
    setSavingCallbacks(true);
    setCallbackErrors({});
    try {
      const result = await api.campaigns.callbacks.save(id, callbacks);
      setCallbacks(result.callbacks);
      setSavedCallbacks(result.callbacks);

      if (result.failed?.length) {
        // A 207 means some saved and some did not — name the ones that failed.
        setCallbackErrors(Object.fromEntries(result.failed.map((f) => [f.type, f.error])));
        toast.error(`${result.failed.length} callback${result.failed.length === 1 ? '' : 's'} rejected by Tonic. The rest were saved.`);
      } else if (result.applied?.length) {
        toast.success(`${result.applied.length} callback${result.applied.length === 1 ? '' : 's'} updated.`);
      } else {
        toast.info('No changes to save.');
      }
    } catch (err) {
      if (err.fields) setCallbackErrors(err.fields);
      toast.error(err.message);
    } finally {
      setSavingCallbacks(false);
    }
  };

  const trackingTargetName = campaign?.trackingTarget?.name || null;
  const callbacksDirty = CALLBACK_FIELDS.some(
    (f) => (callbacks[f.key] || '') !== (savedCallbacks[f.key] || '')
  );

  const slots = Array.from({ length: amount }, (_, i) => keywords[i] || '');
  const filledCount = slots.filter((s) => s.trim()).length;
  const directLink = status?.directLink || campaign?.directLink || null;

  return (
    <Layout
      title="Campaign Details"
      actions={<Link className="btn btn-secondary" to="/campaigns">← Back to campaigns</Link>}
    >
      {/* Header strip, mirroring the dashboard's summary row. */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-body">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            {campaign?.state && (
              <span className={`badge ${campaign.state === 'active' ? 'badge-ok' : campaign.state === 'stopped' ? 'badge-bad' : 'badge-pending'}`}>
                {campaign.state}
              </span>
            )}
            <h2 style={{ margin: 0, fontSize: 21, fontWeight: 500 }}>{campaign?.name || `Campaign ${id}`}</h2>
          </div>

          <div className="summary" style={{ margin: 0 }}>
            <dl style={{ gridTemplateColumns: '130px 1fr' }}>
              <dt>Id</dt><dd className="mono">{id}</dd>
              <dt>Type</dt><dd>{campaign?.type?.toUpperCase() || 'RSOC'}</dd>
              <dt>Vertical &amp; offer</dt>
              <dd>{campaign ? `${campaign.vertical || '—'} | ${campaign.offer || '—'}` : '—'}</dd>
              <dt>Geo</dt><dd>{campaign?.country || '—'}</dd>
              <dt>Tracking target</dt>
              <dd style={{ textTransform: 'capitalize' }}>
                {trackingTargetName || <span className="muted">None</span>}
              </dd>
              <dt>Direct Link</dt>
              <dd>
                {directLink ? (
                  <>
                    <a className="link" href={directLink} target="_blank" rel="noreferrer">{directLink}</a>
                    <button
                      className="btn btn-ghost"
                      style={{ marginLeft: 8 }}
                      onClick={() => {
                        navigator.clipboard?.writeText(directLink)
                          .then(() => toast.success('Direct link copied.'))
                          .catch(() => toast.error('Could not copy to clipboard.'));
                      }}
                    >
                      Copy
                    </button>
                  </>
                ) : (
                  <span className="muted">Not ready yet</span>
                )}
              </dd>
            </dl>
          </div>
        </div>
      </div>

      {loading && <div className="card"><div className="empty">Loading campaign settings…</div></div>}

      {!loading && (
        <>

          {/* ── Keywords ── */}
          <div className="card" style={{ marginBottom: 18 }}>
            <div className="card-head">
              <h2>Keywords <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></h2>
              <button className="btn" onClick={saveKeywords} disabled={savingKeywords}>
                {savingKeywords && <span className="spinner" />}
                {savingKeywords ? 'Saving…' : 'Save keywords'}
              </button>
            </div>
            <div className="card-body">
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <div>
                  <p className="hint" style={{ marginTop: 0 }}>
                    Set your own keywords. Any slots you leave empty are filled with Tonic's
                    recommendations.
                  </p>
                  <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 6 }}>
                    Dynamic location parameters
                  </label>
                  <p className="hint">
                    Inserted from the visitor's location — useful when a keyword reads better with a place
                    in it, e.g. <span className="mono">Car Vendors Near {'{city}'}</span> becomes
                    "Car Vendors Near New York".
                  </p>
                  <div className="toolbar" style={{ gap: 6 }}>
                    {LOCATION_PARAMS.map((p) => (
                      <button
                        key={p}
                        type="button"
                        className="btn btn-secondary mono"
                        style={{ padding: '4px 9px', fontSize: 12 }}
                        title="Copy to clipboard"
                        onClick={() => {
                          navigator.clipboard?.writeText(p);
                          toast.info(`${p} copied.`);
                        }}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="field">
                    <label htmlFor="amount">Keyword amount</label>
                    <p className="hint">How many keywords appear on the page. Between {KEYWORD_MIN} and {KEYWORD_MAX}.</p>
                    <div className="toolbar">
                      <input
                        id="amount"
                        type="range"
                        min={KEYWORD_MIN}
                        max={KEYWORD_MAX}
                        value={amount}
                        style={{ flex: 1 }}
                        onChange={(e) => setAmount(Number(e.target.value))}
                      />
                      <strong style={{ minWidth: 22, textAlign: 'right' }}>{amount}</strong>
                    </div>
                  </div>

                  {slots.map((value, i) => (
                    <input
                      key={i}
                      type="text"
                      style={{ marginBottom: 8 }}
                      placeholder={`Keyword ${i + 1}`}
                      value={value}
                      onChange={(e) => {
                        const next = [...slots];
                        next[i] = e.target.value;
                        setKeywords(next);
                      }}
                    />
                  ))}
                  <p className="counter">
                    {filledCount} set, {amount - filledCount} filled by Tonic
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* ── S2S callbacks ── */}
          <div className="card">
            <div className="card-head">
              <h2>Customized S2S Tracking (Callback) <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></h2>
              <button className="btn" onClick={saveCallbacks} disabled={savingCallbacks || !callbacksDirty}>
                {savingCallbacks && <span className="spinner" />}
                {savingCallbacks ? 'Saving…' : 'Save changes'}
              </button>
            </div>
            <div className="card-body">
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <div>
                  <p className="hint" style={{ marginTop: 0 }}>
                    Tonic sends a GET request to these URLs. Placeholders in the URL are replaced with the
                    event's values, and any query parameter on your tracking link becomes a placeholder
                    too — pass <span className="mono">foo=bar</span> and <span className="mono">{'{foo}'}</span> resolves to "bar".
                  </p>
                  <div className="toolbar" style={{ gap: 6, marginBottom: 16 }}>
                    {PLACEHOLDERS.map((p) => (
                      <button
                        key={p}
                        type="button"
                        className="btn btn-secondary mono"
                        style={{ padding: '4px 9px', fontSize: 12 }}
                        title="Copy to clipboard"
                        onClick={() => {
                          navigator.clipboard?.writeText(p);
                          toast.info(`${p} copied.`);
                        }}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                  <p className="hint">
                    URLs must start with http:// or https://. These campaign-level callbacks override your
                    global settings for this campaign. Tonic monitors the status code your endpoint returns
                    and stops sending after 100 consecutive errors.
                  </p>
                </div>

                <div>
                  {CALLBACK_FIELDS.map((field) => (
                    <div className="field" key={field.key} style={{ marginBottom: 14 }}>
                      <label htmlFor={field.key}>{field.label}</label>
                      <input
                        id={field.key}
                        type="text"
                        className={callbackErrors[field.key] ? 'invalid' : ''}
                        placeholder="https://"
                        value={callbacks[field.key] || ''}
                        onChange={(e) => setCallbacks({ ...callbacks, [field.key]: e.target.value })}
                      />
                      <p className="hint" style={{ margin: '5px 0 0' }}>{field.hint}</p>
                      {callbackErrors[field.key] && <p className="error-text">{callbackErrors[field.key]}</p>}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </Layout>
  );
}
