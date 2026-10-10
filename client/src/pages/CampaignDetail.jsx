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

/**
 * Standard Meta events. The API types these as plain strings, so the list is a
 * suggestion rather than a constraint — hence a datalist, not a select.
 */
const META_EVENTS = [
  'PageView', 'ViewContent', 'Search', 'Lead', 'CompleteRegistration',
  'SubmitApplication', 'Contact', 'Subscribe', 'Purchase', 'AddToCart',
];

/**
 * A sensible starting point for the three additional events, matching what
 * each Tonic event actually is. Offered as defaults to fill in, not presented
 * as Tonic's own recommendation — that mapping lives in their dashboard and
 * guessing at it under their name would be inventing authority.
 */
const SUGGESTED_ADDITIONAL = {
  redirectEventType: 'PageView',
  viewEventType: 'ViewContent',
  viewRtEventType: 'Search',
};

/**
 * Tracking targets, taken field-for-field from the v4 spec's *TrackingTarget
 * schemas. Each one is sent as `traffic.trackingTarget` with its `name`, and
 * the API validates the rest — so the form is generated from this table rather
 * than hand-written per network.
 *
 * Note: `docs/tonic-v4-openapi.json` in this repo is spec 4.16.1 and is behind
 * the live API — the three additional-event fields below exist on Tonic's
 * current FacebookTrackingTarget but not in that file. Re-extract the spec
 * before trusting it for anything new.
 */
const TRACKING_TARGETS = {
  facebook: {
    label: 'Facebook',
    note: 'New Facebook S2S conversions with default mappings is used.',
    revenue: true,
    fields: [
      { key: 'eventType', label: 'Event type', required: true, options: ['Lead', 'Purchase', 'CompleteRegistration', 'SubmitApplication', 'Contact', 'Subscribe'], hint: 'The standard event Tonic fires on your pixel.' },
      { key: 'pixelId', label: 'Pixel ID', required: true },
      { key: 'accessToken', label: 'Access token', required: true, secret: true },
      { key: 'domainVerificationToken', label: 'Domain verification token', required: false },

      // Tonic's dashboard calls these "Additional events". Each maps to one of
      // the events the campaign already fires, so the label names both: what
      // Tonic calls it, and what actually triggers it.
      { key: 'redirectEventType', label: 'Page opened', section: 'Additional events', options: META_EVENTS,
        hint: 'Fired on redirect, when the visitor lands on the article.' },
      { key: 'viewEventType', label: 'RSoC unit requested', section: 'Additional events', options: META_EVENTS,
        hint: 'Fired on view, when the keyword page is shown.' },
      { key: 'viewRtEventType', label: 'Related term clicked', section: 'Additional events', options: META_EVENTS,
        hint: 'Fired on viewRt, when a related term is clicked.' },
    ],
  },
  tiktok: {
    label: 'TikTok',
    revenue: true,
    fields: [
      { key: 'pixelId', label: 'Pixel ID', required: true },
      { key: 'accessToken', label: 'Access token', required: true, secret: true },
    ],
  },
  taboola: {
    label: 'Taboola',
    fields: [{ key: 'eventName', label: 'Event name', required: true, hint: 'e.g. lead' }],
  },
  outbrain: {
    label: 'Outbrain',
    fields: [{ key: 'eventBasedConversionName', label: 'Event-based conversion name', required: true }],
  },
  gdn: {
    label: 'Google Ads / GDN',
    fields: [
      { key: 'conversionId', label: 'Conversion ID', required: true, hint: 'Unique per Google Ads account.' },
      { key: 'conversionLabel', label: 'Conversion label', required: true, hint: 'Unique per conversion action.' },
    ],
  },
  mgid: {
    label: 'MGID',
    fields: [
      { key: 'eventName', label: 'Event name', required: true },
      { key: 'sendRevenue', label: 'Append pre-estimated revenue as the "r" parameter', type: 'boolean' },
    ],
  },
  newsbreak: {
    label: 'Newsbreak',
    fields: [{ key: 'eventName', label: 'Event name', required: true, hint: 'e.g. complete_payment' }],
  },
};

const REVENUE_TYPES = [
  { value: 'preEstimatedRevenue', label: 'Pre-Estimated Revenue', hint: 'Sent immediately, least settled.' },
  { value: 'estimatedRevenue', label: 'Estimated Revenue', hint: 'Sent once Tonic has an estimate — the usual choice.' },
];

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

  // Tracking target. `target` is the network name ('' = none); `targetFields`
  // holds whatever that network needs.
  // Renaming happens in place on the heading rather than in a drawer — it is
  // one field, and a dialog for one field is a dialog too many.
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);

  const [target, setTarget] = useState('');
  const [targetFields, setTargetFields] = useState({});
  const [revenueType, setRevenueType] = useState('estimatedRevenue');
  const [targetErrors, setTargetErrors] = useState({});
  const [savingTarget, setSavingTarget] = useState(false);

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
        if (found && !cancelled) {
          setCampaign({ ...found, state: found.status });
          hydrateTarget(found.trackingTarget);
        }
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

  const startRename = () => {
    setNameDraft(campaign?.name || '');
    setRenaming(true);
  };

  const saveName = async () => {
    const name = nameDraft.trim();
    if (!name) {
      toast.error('A campaign needs a name.');
      return;
    }
    if (name === campaign?.name) {
      setRenaming(false);
      return;
    }

    setSavingName(true);
    try {
      const row = await api.campaigns.update(id, { name });
      setCampaign((c) => ({ ...c, name: row?.name || name }));
      setRenaming(false);
      toast.success('Campaign renamed.');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingName(false);
    }
  };

  /** Pull the saved target off the campaign once it loads. */
  const hydrateTarget = (tt) => {
    const name = String(tt?.name || '').toLowerCase();
    if (!TRACKING_TARGETS[name]) {
      setTarget('');
      setTargetFields({});
      return;
    }
    setTarget(name);
    setRevenueType(tt.revenueType || 'estimatedRevenue');
    setTargetFields(
      Object.fromEntries(TRACKING_TARGETS[name].fields.map((f) => [f.key, tt[f.key] ?? (f.type === 'boolean' ? false : '')]))
    );
  };

  const chooseTarget = (name) => {
    setTarget(name);
    setTargetErrors({});
    setTargetFields(
      name ? Object.fromEntries(TRACKING_TARGETS[name].fields.map((f) => [f.key, f.type === 'boolean' ? false : ''])) : {}
    );
  };

  const saveTarget = async () => {
    const spec = TRACKING_TARGETS[target];

    // Checked here as well as by Tonic, so a missing pixel ID is caught before
    // the round trip rather than coming back as a generic validation error.
    const errors = {};
    for (const f of spec?.fields || []) {
      if (f.required && !String(targetFields[f.key] ?? '').trim()) errors[f.key] = 'Required.';
    }
    setTargetErrors(errors);
    if (Object.keys(errors).length) return;

    setSavingTarget(true);
    try {
      // An empty selection clears it: the API takes null for "no target".
      const payload = !target ? null : {
        name: target,
        ...Object.fromEntries(
          spec.fields
            .map((f) => [f.key, f.type === 'boolean' ? Boolean(targetFields[f.key]) : String(targetFields[f.key] ?? '').trim()])
            .filter(([, v]) => v !== '')
        ),
        ...(spec.revenue ? { revenueType } : {}),
      };

      const res = await api.campaigns.trackingTarget(id, payload);
      hydrateTarget(res.trackingTarget);
      toast.success(target ? `${spec.label} tracking saved.` : 'Tracking target cleared.');
    } catch (err) {
      if (err.fields) setTargetErrors(err.fields);
      toast.error(err.message);
    } finally {
      setSavingTarget(false);
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

  const trackingTargetName = target ? TRACKING_TARGETS[target]?.label : null;
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
            {renaming ? (
              <div className="toolbar" style={{ flex: 1, minWidth: 0 }}>
                <input
                  type="text"
                  value={nameDraft}
                  autoFocus
                  disabled={savingName}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveName();
                    if (e.key === 'Escape') setRenaming(false);
                  }}
                  style={{ fontSize: 17, maxWidth: 560 }}
                  aria-label="Campaign name"
                />
                <button className="btn" onClick={saveName} disabled={savingName}>
                  {savingName && <span className="spinner" />}
                  {savingName ? 'Saving…' : 'Save'}
                </button>
                <button className="btn btn-ghost" onClick={() => setRenaming(false)} disabled={savingName}>
                  Cancel
                </button>
              </div>
            ) : (
              <>
                <h2 style={{ margin: 0, fontSize: 21, fontWeight: 500 }}>
                  {campaign?.name || `Campaign ${id}`}
                </h2>
                <button
                  className="icon-btn icon-btn-plain"
                  onClick={startRename}
                  title="Rename campaign"
                  aria-label="Rename campaign"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" />
                  </svg>
                </button>
              </>
            )}
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

          {/* ── Tracking target / pixel ── */}
          <div className="card" style={{ marginBottom: 18 }}>
            <div className="card-head">
              <h2>Tracking Target <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></h2>
              <button className="btn" onClick={saveTarget} disabled={savingTarget}>
                {savingTarget && <span className="spinner" />}
                {savingTarget ? 'Saving…' : 'Save tracking target'}
              </button>
            </div>

            <div className="card-body">
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <div>
                  <p className="hint" style={{ marginTop: 0 }}>
                    Sends conversions straight from Tonic to your ad platform, server to server —
                    no pixel on the page. Changing the target can override other settings, so
                    check the callbacks below after saving.
                  </p>
                  {target && TRACKING_TARGETS[target].note && (
                    <p className="hint"><strong>{TRACKING_TARGETS[target].note}</strong></p>
                  )}
                </div>

                <div>
                  <div className="field">
                    <label htmlFor="tracking-target">Tracking target</label>
                    <select
                      id="tracking-target"
                      value={target}
                      onChange={(e) => chooseTarget(e.target.value)}
                    >
                      <option value="">None</option>
                      {Object.entries(TRACKING_TARGETS).map(([key, t]) => (
                        <option key={key} value={key}>{t.label}</option>
                      ))}
                    </select>
                  </div>

                  {target && TRACKING_TARGETS[target].revenue && (
                    <div className="field">
                      <label>Revenue sent</label>
                      {REVENUE_TYPES.map((r) => (
                        <label key={r.value} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8, fontWeight: 400 }}>
                          <input
                            type="radio"
                            name="revenueType"
                            value={r.value}
                            checked={revenueType === r.value}
                            onChange={() => setRevenueType(r.value)}
                            style={{ width: 'auto', marginTop: 3 }}
                          />
                          <span>
                            {r.label}
                            <span className="hint" style={{ display: 'block' }}>{r.hint}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  )}

                  {target && TRACKING_TARGETS[target].fields.map((f, i, all) => (
                    <div className="field" key={f.key}>
                      {f.section && f.section !== all[i - 1]?.section && (
                        <div className="card-head" style={{ padding: '4px 0 10px', borderBottom: 0 }}>
                          <h2 style={{ fontSize: 13 }}>
                            {f.section} <span className="muted" style={{ fontWeight: 400 }}>(optional)</span>
                          </h2>
                          <button
                            type="button"
                            className="btn btn-ghost"
                            style={{ padding: '2px 6px', fontSize: 12 }}
                            onClick={() => setTargetFields((v) => ({ ...v, ...SUGGESTED_ADDITIONAL }))}
                          >
                            Fill with common defaults
                          </button>
                        </div>
                      )}
                      {f.type === 'boolean' ? (
                        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400 }}>
                          <input
                            type="checkbox"
                            checked={Boolean(targetFields[f.key])}
                            onChange={(e) => setTargetFields((v) => ({ ...v, [f.key]: e.target.checked }))}
                            style={{ width: 'auto' }}
                          />
                          {f.label}
                        </label>
                      ) : (
                        <>
                          <label htmlFor={`tt-${f.key}`}>
                            {f.label}
                            {!f.required && <span className="muted" style={{ fontWeight: 400 }}> (optional)</span>}
                          </label>
                          {f.hint && <p className="hint">{f.hint}</p>}
                          <input
                            id={`tt-${f.key}`}
                            type={f.secret ? 'password' : 'text'}
                            autoComplete="off"
                            list={f.options ? `tt-${f.key}-options` : undefined}
                            className={targetErrors[f.key] ? 'invalid' : ''}
                            value={targetFields[f.key] ?? ''}
                            onChange={(e) => setTargetFields((v) => ({ ...v, [f.key]: e.target.value }))}
                          />
                          {/* A datalist rather than a select: these are the common
                              values, but the API takes any string and a closed list
                              would block a valid one. */}
                          {f.options && (
                            <datalist id={`tt-${f.key}-options`}>
                              {f.options.map((o) => <option key={o} value={o} />)}
                            </datalist>
                          )}
                          {targetErrors[f.key] && <p className="error-text">{targetErrors[f.key]}</p>}
                        </>
                      )}
                    </div>
                  ))}
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
