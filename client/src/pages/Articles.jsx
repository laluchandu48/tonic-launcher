import { useEffect, useMemo, useState } from 'react';
import Layout from '../components/Layout.jsx';
import Drawer from '../components/Drawer.jsx';
import { useToast } from '../components/Toast.jsx';
import { api } from '../lib/api.js';
import { languageName, byLanguageName } from '../lib/languages.js';

const PHRASE_SLOTS = 5;
const REQUIRED_PHRASES = 3;

const statusTone = (status) => ({
  published: 'badge-ok',
  approved: 'badge-ok',
  pending: 'badge-pending',
  rejected: 'badge-bad',
}[String(status || '').toLowerCase()] || 'badge-idle');

const emptyForm = {
  domain: '',
  language: '',
  country: '',
  offerId: '',
  headline: '',
  teaser: '',
  phrases: Array(PHRASE_SLOTS).fill(''),
  citationLink: '',
};

export default function Articles() {
  const toast = useToast();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [domains, setDomains] = useState([]);
  const [countries, setCountries] = useState([]);
  const [offers, setOffers] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [needsCredentials, setNeedsCredentials] = useState(false);

  // Launching straight from an article row, the way Tonic's own Articles list does.
  const [counts, setCounts] = useState({});
  const [launchFor, setLaunchFor] = useState(null);
  const [campaignName, setCampaignName] = useState('');
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState('');

  /**
   * How many campaigns already point at each article. Tonic shows this beside
   * the launch link, so you can see at a glance what you have already used.
   * Stats are skipped — only the article id of each campaign matters here.
   */
  const loadCounts = async () => {
    try {
      const { rows } = await api.campaigns.list('pending,active,stopped', { stats: 'false' });
      const tally = {};
      for (const c of rows || []) {
        if (c.articleId != null) tally[c.articleId] = (tally[c.articleId] || 0) + 1;
      }
      setCounts(tally);
    } catch {
      // The count is a convenience; a failure here must not blank the list.
    }
  };

  const load = async () => {
    try {
      const result = await api.articles.list();
      setRequests(result.rows || []);
      loadCounts();
    } catch (err) {
      if (err.code === 'NO_CREDENTIALS') setNeedsCredentials(true);
      else toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openDrawer = async () => {
    setForm(emptyForm);
    setErrors({});
    setDrawerOpen(true);
    try {
      const [d, c, o] = await Promise.all([
        api.lookups.domains(),
        api.lookups.countries(),
        api.lookups.offers(),
      ]);
      setDomains(d);
      setCountries(c);
      setOffers(o);
    } catch (err) {
      toast.error(`Could not load options: ${err.message}`);
    }
  };

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  /** A domain only accepts certain languages, so the choice of domain narrows it. */
  const languageOptions = useMemo(() => {
    const selected = domains.find((d) => d.domain === form.domain);
    const codes = selected
      ? (selected.languages || [])
      : [...new Set(domains.flatMap((d) => d.languages || []))];
    // Sorted by the name shown, so the list reads alphabetically to a person.
    return [...codes].sort(byLanguageName);
  }, [domains, form.domain]);

  const filledPhrases = form.phrases.map((p) => p.trim()).filter(Boolean);

  /** Same rules the server and Tonic enforce, checked before the round trip. */
  const validate = () => {
    const next = {};
    if (!form.domain) next.domain = 'Choose a domain.';
    if (!form.language) next.language = 'Choose a language.';
    if (!form.country) next.country = 'Choose a GEO.';
    if (!form.offerId) next.offerId = 'Choose an offer.';
    if (filledPhrases.length < REQUIRED_PHRASES) {
      next.phrases = `Provide at least ${REQUIRED_PHRASES} content generation phrases.`;
    }
    if (form.headline.length > 256) next.headline = 'Maximum 256 characters.';
    if (form.teaser.trim()) {
      if (form.teaser.trim().length < 250) next.teaser = 'The teaser must be at least 250 characters.';
      else if (form.teaser.trim().length > 1000) next.teaser = 'Maximum 1000 characters.';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async () => {
    if (!validate()) return;
    setSubmitting(true);
    try {
      const offer = offers.find((o) => o.id === form.offerId);
      const created = await api.articles.create({
        offerId: form.offerId,
        offerName: offer?.name,
        country: form.country,
        language: form.language,
        domain: form.domain,
        headline: form.headline.trim() || undefined,
        teaser: form.teaser.trim() || undefined,
        contentGenerationPhrases: filledPhrases,
        citationLinks: form.citationLink.trim() ? [form.citationLink.trim()] : undefined,
      });
      setDrawerOpen(false);
      setRequests((all) => [created, ...all]);
      toast.success(`Article request ${created.tonic_request_id ?? ''} created. It stays pending until Tonic publishes it.`);
      load();
    } catch (err) {
      if (err.fields) setErrors(err.fields);
      toast.error(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  /** Only a published article has an id Tonic will accept on a campaign. */
  const articleIdOf = (r) => r.articleId ?? r.headline_id ?? null;
  const canLaunch = (r) =>
    articleIdOf(r) != null &&
    ['published', 'approved'].includes(String(r.status || '').toLowerCase());

  const openLaunch = (r) => {
    setLaunchFor(r);
    setLaunchError('');
    setCampaignName([r.offer_name, r.country, languageName(r.language)].filter(Boolean).join(' - '));
  };

  const launch = async () => {
    const name = campaignName.trim();
    if (!name) {
      setLaunchError('Give the campaign a name.');
      return;
    }
    setLaunching(true);
    try {
      const created = await api.campaigns.create({ name, articleId: articleIdOf(launchFor) });
      setLaunchFor(null);
      toast.success(
        created.tonic_campaign_id
          ? `Campaign ${created.name} created (id ${created.tonic_campaign_id}).`
          : `Campaign created. ${created.note || ''}`
      );
      loadCounts();
    } catch (err) {
      setLaunchError(err.message);
      toast.error(err.message);
    } finally {
      setLaunching(false);
    }
  };

  return (
    <Layout
      title="Articles"
      actions={<button className="btn" onClick={openDrawer} disabled={needsCredentials}>Create Article Request</button>}
    >
      {needsCredentials && (
        <div className="banner banner-warn">
          <span>⚠</span>
          <div>No Tonic credentials yet. Add them on the <a href="/settings">Settings</a> screen to start creating article requests.</div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>Article requests</h2>
          <div className="toolbar">
            <button className="btn btn-secondary" onClick={load} disabled={loading || needsCredentials}>
              {loading && <span className="spinner" />}
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="empty">Loading…</div>
        ) : requests.length === 0 ? (
          <div className="empty">
            <p>No article requests yet.</p>
            <button className="btn" onClick={openDrawer} disabled={needsCredentials}>Create the first one</button>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Request</th>
                <th>Article ID</th>
                <th>Status</th>
                <th>Offer</th>
                <th>GEO</th>
                <th>Language</th>
                <th>Domain</th>
                <th>Created</th>
                <th>Campaigns</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.tonic_request_id || <span className="muted">—</span>}</td>
                  <td className="mono">{r.articleId ?? r.headline_id ?? <span className="muted">—</span>}</td>
                  <td>
                    <span className={`badge ${statusTone(r.status)}`}>{r.status}</span>
                    {r.error && <div className="error-text" title={r.error}>{r.error.slice(0, 80)}</div>}
                  </td>
                  <td>{r.offer_name || r.offer_id || <span className="muted">—</span>}</td>
                  <td>{r.country}</td>
                  <td>{languageName(r.language)}</td>
                  <td className="muted">{r.domain}</td>
                  <td className="muted">{r.created_at?.slice(0, 16)}</td>
                  <td className="mono">{counts[articleIdOf(r)] ?? 0}</td>
                  <td>
                    {canLaunch(r) ? (
                      <button className="btn btn-ghost" onClick={() => openLaunch(r)}>Create campaign</button>
                    ) : (
                      <span className="muted" title="Available once Tonic publishes the article">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Drawer
        title="Create Campaign"
        open={Boolean(launchFor)}
        onClose={() => setLaunchFor(null)}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setLaunchFor(null)}>Cancel</button>
            <button className="btn" onClick={launch} disabled={launching}>
              {launching && <span className="spinner" />}
              {launching ? 'Creating…' : 'Create Campaign'}
            </button>
          </>
        }
      >
        {launchFor && (
          <>
            <div className="field">
              <label htmlFor="campaign-name">Campaign name</label>
              <p className="hint">The offer, GEO and language come from the article itself.</p>
              <input
                id="campaign-name"
                type="text"
                className={launchError ? 'invalid' : ''}
                value={campaignName}
                autoFocus
                onChange={(e) => { setCampaignName(e.target.value); setLaunchError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !launching) launch(); }}
              />
              {launchError && <p className="error-text">{launchError}</p>}
            </div>

            <div className="summary">
              <dl>
                <dt>Article ID</dt>
                <dd className="mono">{articleIdOf(launchFor)}</dd>
                <dt>Title</dt>
                <dd>{launchFor.headline || <span className="muted">—</span>}</dd>
                <dt>Offer</dt>
                <dd>{launchFor.offer_name || launchFor.offer_id || <span className="muted">—</span>}</dd>
                <dt>Vertical</dt>
                <dd>{launchFor.vertical_name || <span className="muted">—</span>}</dd>
                <dt>GEO</dt>
                <dd>{launchFor.country}</dd>
                <dt>Language</dt>
                <dd>{languageName(launchFor.language)}</dd>
              </dl>
            </div>
          </>
        )}
      </Drawer>

      <Drawer
        title="Create Article Request"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setDrawerOpen(false)}>Cancel</button>
            <button className="btn" onClick={submit} disabled={submitting}>
              {submitting && <span className="spinner" />}
              {submitting ? 'Creating…' : 'Create new Article'}
            </button>
          </>
        }
      >
        <div className="row">
          <div className="field">
            <label htmlFor="domain">Domain</label>
            <select
              id="domain"
              className={errors.domain ? 'invalid' : ''}
              value={form.domain}
              onChange={(e) => set({ domain: e.target.value, language: '' })}
            >
              <option value="">Select a domain</option>
              {domains.map((d) => <option key={d.domain} value={d.domain}>{d.domain}</option>)}
            </select>
            {errors.domain && <p className="error-text">{errors.domain}</p>}
          </div>

          <div className="field">
            <label htmlFor="language">Language</label>
            <select
              id="language"
              className={errors.language ? 'invalid' : ''}
              value={form.language}
              onChange={(e) => set({ language: e.target.value })}
            >
              <option value="">Select a language</option>
              {languageOptions.map((l) => <option key={l} value={l}>{languageName(l)}</option>)}
            </select>
            {errors.language && <p className="error-text">{errors.language}</p>}
            {form.domain && <p className="hint" style={{ marginTop: 6 }}>Limited to what this domain accepts.</p>}
          </div>
        </div>

        <div className="field">
          <label htmlFor="country">GEO</label>
          <select
            id="country"
            className={errors.country ? 'invalid' : ''}
            value={form.country}
            onChange={(e) => set({ country: e.target.value })}
          >
            <option value="">Select a country</option>
            <option value="WO">WO — Worldwide</option>
            {countries.map((c) => <option key={c.code} value={c.code}>{c.code}{c.name ? ` — ${c.name}` : ''}</option>)}
          </select>
          {errors.country && <p className="error-text">{errors.country}</p>}
        </div>

        <div className="field">
          <label htmlFor="offer">Offer</label>
          <select
            id="offer"
            className={errors.offerId ? 'invalid' : ''}
            value={form.offerId}
            onChange={(e) => set({ offerId: e.target.value })}
          >
            <option value="">Select an offer</option>
            {offers.map((o) => (
              <option key={o.id} value={o.id}>{o.name}{o.vertical ? ` — ${o.vertical}` : ''}</option>
            ))}
          </select>
          {errors.offerId && <p className="error-text">{errors.offerId}</p>}
        </div>

        <div className="field">
          <label htmlFor="headline">Title <span className="muted">(optional)</span></label>
          <p className="hint">
            A concise title that accurately reflects the article's content and ad creatives.
            Avoid prices, endorsements, time-sensitive offers, or anything implying a reward for clicking.
          </p>
          <input
            id="headline"
            type="text"
            className={errors.headline ? 'invalid' : ''}
            value={form.headline}
            maxLength={280}
            onChange={(e) => set({ headline: e.target.value })}
          />
          <p className="counter">{form.headline.length} / 256</p>
          {errors.headline && <p className="error-text">{errors.headline}</p>}
        </div>

        <div className="field">
          <label htmlFor="teaser">Teaser <span className="muted">(optional)</span></label>
          <p className="hint">
            An opening that conveys the essence of the article. If you write one it must be
            between 250 and 1000 characters — Tonic rejects teasers it reads as promotional.
          </p>
          <textarea
            id="teaser"
            className={errors.teaser ? 'invalid' : ''}
            value={form.teaser}
            onChange={(e) => set({ teaser: e.target.value })}
          />
          <p className="counter">{form.teaser.trim().length} / 1000{form.teaser.trim().length > 0 && form.teaser.trim().length < 250 ? ' (250 minimum)' : ''}</p>
          {errors.teaser && <p className="error-text">{errors.teaser}</p>}
        </div>

        <div className="field">
          <label>Content Generation Phrases</label>
          <p className="hint">
            Three to five phrases that expand on the teaser and align with the ad creative.
            These drive what the article actually says.
          </p>
          {form.phrases.map((phrase, i) => (
            <input
              key={i}
              type="text"
              style={{ marginBottom: 8 }}
              placeholder={`Phrase ${i + 1}${i < REQUIRED_PHRASES ? '' : ' (optional)'}`}
              value={phrase}
              onChange={(e) => {
                const next = [...form.phrases];
                next[i] = e.target.value;
                set({ phrases: next });
              }}
            />
          ))}
          <p className="counter">{filledPhrases.length} of {REQUIRED_PHRASES}–{PHRASE_SLOTS} provided</p>
          {errors.phrases && <p className="error-text">{errors.phrases}</p>}
          {errors.contentGenerationPhrases && <p className="error-text">{errors.contentGenerationPhrases}</p>}
        </div>

        <div className="field">
          <label htmlFor="citation">Citation link <span className="muted">(optional)</span></label>
          <p className="hint">
            One reputable third-party URL supporting the article. This is off by default —
            your account manager has to enable it, otherwise Tonic rejects the request.
          </p>
          <input
            id="citation"
            type="url"
            value={form.citationLink}
            onChange={(e) => set({ citationLink: e.target.value })}
            placeholder="https://"
          />
          {errors.citationLinks && <p className="error-text">{errors.citationLinks}</p>}
        </div>
      </Drawer>
    </Layout>
  );
}
