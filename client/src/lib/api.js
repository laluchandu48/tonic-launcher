/**
 * Thin wrapper over fetch. Every server error arrives as { error, fields? },
 * so throw an Error carrying `fields` for forms to read.
 */
async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }

  if (!res.ok) {
    const message = payload?.error || payload?.message || `Request failed (${res.status})`;
    const error = new Error(message);
    error.status = res.status;
    error.fields = payload?.fields || null;
    error.code = payload?.code || null;
    throw error;
  }
  return payload;
}

export const api = {
  health: () => request('/health'),

  stats: {
    get: ({ from, to, group }) => {
      const q = new URLSearchParams();
      if (from) q.set('from', from);
      if (to) q.set('to', to);
      if (group) q.set('group', group);
      return request(`/stats?${q}`);
    },
    today: () => request('/stats/today'),
    summary: () => request('/stats/summary'),
    refreshAllTime: () => request('/stats/alltime/refresh', { method: 'POST' }),
    offers: ({ from, to, limit } = {}) => {
      const q = new URLSearchParams();
      if (from) q.set('from', from);
      if (to) q.set('to', to);
      if (limit) q.set('limit', limit);
      return request(`/stats/offers?${q}`);
    },
    lastFinal: () => request('/stats/last-final'),
    account: () => request('/lookups/account'),
  },

  settings: {
    get: () => request('/settings'),
    save: (consumerKey, consumerSecret) =>
      request('/settings/credentials', { method: 'POST', body: { consumerKey, consumerSecret } }),
    test: () => request('/settings/test', { method: 'POST' }),
    clear: () => request('/settings/credentials', { method: 'DELETE' }),
  },

  lookups: {
    offers: (country) => request(`/lookups/offers${country ? `?country=${encodeURIComponent(country)}` : ''}`),
    countries: (offerId) => request(`/lookups/countries${offerId ? `?offer_id=${encodeURIComponent(offerId)}` : ''}`),
    domains: () => request('/lookups/domains'),
    headlines: () => request('/lookups/headlines'),
  },

  compliance: {
    adIds: (params) => request(`/compliance/ad-ids?${new URLSearchParams(params)}`),
    adIdDetail: (id) => request(`/compliance/ad-ids/${encodeURIComponent(id)}`),
    changeLog: (params) => request(`/compliance/ad-ids/change-log?${new URLSearchParams(params)}`),
    reviewRequest: (payload) =>
      request('/compliance/ad-ids/review-request', { method: 'POST', body: payload }),
    siteIds: (params) => request(`/compliance/site-ids?${new URLSearchParams(params)}`),
    trafficCheck: (params) => request(`/compliance/traffic-check?${new URLSearchParams(params)}`),
    parameters: (params) => request(`/compliance/parameters?${new URLSearchParams(params)}`),
  },

  articles: {
    // v4 returns the live list with status and rejection reason, so the old
    // "sync from Tonic" step no longer exists — this is always current.
    list: (params) => request(`/articles?${new URLSearchParams(params || {})}`),
    get: (id) => request(`/articles/${id}`),
    create: (payload) => request('/articles', { method: 'POST', body: payload }),
    deleteArticle: (articleId) => request(`/articles/article/${articleId}`, { method: 'DELETE' }),
  },

  campaigns: {
    list: (state = 'active', params = {}) =>
      request(`/campaigns?${new URLSearchParams({ state, ...params })}`),
    launched: () => request('/campaigns/launched'),
    status: (id) => request(`/campaigns/${id}/status`),
    create: (payload) => request('/campaigns', { method: 'POST', body: payload }),
    update: (id, patch) => request(`/campaigns/${id}`, { method: 'PATCH', body: patch }),
    trackingTarget: (id, trackingTarget) =>
      request(`/campaigns/${id}/tracking-target`, { method: 'PUT', body: { trackingTarget } }),

    keywords: {
      get: (id) => request(`/campaigns/${id}/keywords`),
      save: (id, amount, keywords) =>
        request(`/campaigns/${id}/keywords`, { method: 'PUT', body: { amount, keywords } }),
    },

    callbacks: {
      get: (id) => request(`/campaigns/${id}/callbacks`),
      save: (id, callbacks) =>
        request(`/campaigns/${id}/callbacks`, { method: 'PUT', body: { callbacks } }),
    },
  },
};
