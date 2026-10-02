# Tonic Launcher

Launch Tonic RSOC campaigns through the Publisher API instead of the Tonic dashboard.

The flow mirrors what the dashboard does:

1. **Create an article request** — offer, GEO, language, domain and 3–5 content generation phrases.
2. **Tonic reviews and publishes it.** Sync pulls the current status back.
3. A published article carries a **`headline_id`**.
4. **Create a campaign** against that `headline_id` to get a direct link.

## Requirements

- Node.js 18 or newer (tested on 22)
- Tonic API credentials — Account Settings → API in the Tonic publisher dashboard

## Running locally

```bash
npm run install-all     # first time only
npm run dev
```

- Client: http://localhost:5173
- API: http://localhost:5050

Open the client, go to **Settings**, paste your consumer key and secret, and press
**Save and verify** — the server authenticates against Tonic before accepting them,
so a typo fails there rather than on your first article request.

Credentials can also be supplied by environment instead. Copy `server/.env.example`
to `server/.env` and fill in `TONIC_CONSUMER_KEY` / `TONIC_CONSUMER_SECRET`; those
take precedence over anything saved through the UI.

## Layout

```
server/
  src/
    lib/tonic.js        Tonic API client — JWT lifecycle, error normalising
    lib/credentials.js  Where credentials come from; shared client instance
    lib/http.js         Async route wrapper, credential guard, error handler
    db/index.js         SQLite schema + repositories (the only SQL in the app)
    routes/             settings, lookups, articles, campaigns
    index.js            Express app
client/
  src/
    lib/api.js          Typed-ish wrapper over fetch
    components/         Layout, Drawer, Toast
    pages/              Dashboard, Articles, Campaigns, Settings
```

## Design notes

**Credentials never reach the browser.** They live in SQLite (or the environment)
and the settings API only reports whether they are configured plus a masked key.
Every Tonic call is made server-side.

**One shared JWT.** Tonic tokens last 90 minutes. The client caches one, refreshes
it a minute before expiry, and re-authenticates once on a 401 before giving up.
Concurrent requests share a single in-flight authentication.

**`direct_link`, not `link`.** Since 09 Feb 2026 Tonic returns `link: null` for
newly created campaigns and is retiring classic redirect links. The campaign list
reads `direct_link` first and flags any campaign still relying on the legacy field.

**Rejected article requests are kept.** Tonic rejects requests for reasons worth
seeing again ("Teaser too promotional"), so a failed attempt is stored locally with
its error rather than discarded.

**Validation is duplicated on purpose.** The 3–5 phrase count, the 256-character
headline limit and the 250–1000 character teaser range are enforced client-side,
server-side and by Tonic. The first two exist to avoid a pointless round trip;
Tonic remains the authority.

## Deploying to AWS

The server serves the built client from the same process, so this ships as one
container or one EC2 instance.

```bash
npm run build     # builds client/dist
npm start         # server serves the API and the built client
```

Two things to change for production:

- **Database.** SQLite is a local file. All SQL lives in `server/src/db/index.js`
  behind repository objects — swap that one file for RDS Postgres and nothing else
  in the app changes.
- **Secrets.** Move the Tonic credentials to Secrets Manager or SSM Parameter
  Store; only `readCredentials()` in `server/src/lib/credentials.js` needs to change.

Also set `CORS_ORIGIN` to the deployed origin rather than leaving it open.

## Campaign settings

Clicking a campaign opens its settings page, which reproduces the dashboard's
Campaign Details screen for the parts the API exposes:

- **Keywords** — amount (3–10) plus a slot per keyword. Slots left empty are filled
  by Tonic's own suggestions. The dynamic location parameters (`{city}`, `{in state}`
  and friends) are listed as copy buttons.
- **Customized S2S Tracking** — the seven callback events. Tonic has no bulk endpoint,
  so saving diffs against what is stored: changed URLs are POSTed, cleared ones are
  DELETEd, unchanged ones are skipped. Each event is reported on its own, so one URL
  Tonic rejects does not silently discard the others (that save returns HTTP 207).

**Tracking Target is missing on purpose.** The dashboard has a traffic-source dropdown
on this page, but the words "tracking target" and "traffic source" appear nowhere in
the v3 documentation and no endpoint covers it. It has to be set in the Tonic
dashboard. The page says so rather than pretending the field does not exist.

## Stats

The campaigns overview shows Views, Clicks, VTC, RPC, RPMV and Revenue, with
status filter chips, a date range, Campaign/Day/Month grouping, and Total and
Average rows.

No single endpoint provides these, so `/api/stats` joins two:

- `reports/tracking` → clicks and `revenueUsd`, at most 31 days per call,
  nothing before 2023-01-01.
- `session/daily` → views, from the raw session rows (`view` / `ad_click` flags).
  It takes **one date per call** and Tonic keeps only the **last 8 days**, so
  views cost one request per day and are simply unavailable further back. Ranges
  that reach past the limit still show clicks and revenue, with a note saying
  views, VTC and RPMV are incomplete.

VTC, RPC and RPMV are derived: clicks ÷ views, revenue ÷ clicks, and
revenue ÷ views × 1000.

Two things to keep in mind when reading the numbers: Tonic reports RPC as 0 until
a campaign passes 10 clicks (its upstream provider withholds click data below
that), and revenue for any day after the last finalised day is an estimate that
gets corrected later. Dates resolve in Tonic's server timezone (PST/PDT), not the
browser's.

## Dashboard

Four launcher counters at the top, then the account numbers, charts and daily
stats, with the flow explainer at the bottom.

Tonic's older dashboard names the same six metrics differently — Uniques is
views, Conversions is clicks, CTR is VTC, CPC is RPC, RPM is RPMV. The dashboard
uses Tonic's names; the campaigns overview uses the beta UI's.

**All-time revenue is cached, not fetched.** A tracking report covers at most 31
days, so a true all-time figure means one call per month back to 2023-01 — about
33 requests. Those are stored in `revenue_months`: finished months never change
and are kept forever, the current month is refreshed on each dashboard load, and
the backfill runs only when you press Calculate. A second backfill costs one call.

**The uniques-and-revenue chart is two plots, not one.** Tonic's version puts both
series in a single frame on two y-scales. The alignment between two such scales is
arbitrary, so the chart implies a correlation that isn't in the data. Same data,
same x axis, one scale each.

**Top offers is ranked bars rather than a pie.** Offer names are long and several
shares sit close together, which is where slices stop being readable. The tracking
report has no offer column, so revenue is mapped to offers through the campaign
lists; campaigns that no longer appear there fall into "Unknown offer".

Charts are hand-drawn SVG — no charting dependency. The fill is `#2a78d6`,
from a palette validated for contrast and chroma against the chart surface.

## The API

Everything runs on **v4** (`api.publisher.tonic.com/v4`, spec 4.16.1). Tonic is
shutting v3 down, and the v3 client has been removed.

v4 takes camelCase credentials (`consumerKey`/`consumerSecret`), issues an access
**and** refresh token, wraps every response in
`{ data, warnings, pagination, sorting }`, and pages with limit/offset. All of
that is handled in `server/src/lib/tonicV4.js`, which returns
`{ data, pagination, warnings }` so no route has to know the envelope exists.

The spec is saved at `docs/tonic-v4-openapi.json`. Tonic's own
"Download OpenApiV3 Config" button returns `null`, so this copy was extracted
from the live Swagger UI's own state — it may be the only working copy.

### What the migration changed

| Was (v3) | Now (v4) |
|---|---|
| `campaign/list` + `reports/tracking` + `session/daily`, joined by hand | `GET /campaigns?stats=true&from&to` — views, clicks, vtc, revenue, rpc, rpmv arrive on each row |
| day/month aggregation computed locally | `GET /campaigns/performance?grouping=day\|month` |
| `campaign/rename`, `campaign/keywords`, `campaign/callback` (get/set/delete each) | one `PATCH /campaigns` taking an array of datasets |
| `campaign/create` with offer, country and headline | `POST /campaigns {name, articleId}` — the article carries the rest |
| `rsoc/*` | `/articles` and `/articles/requests` |
| `rsoc/domains` | `GET /account` → `availableRsocDomains` |
| `last/final` | `GET /statistics/status` |

Three consequences worth knowing:

- **The 8-day view-count limit is gone.** Date ranges are now capped by v4 itself:
  31 days for day grouping, 186 for month.
- **"Sync from Tonic" was removed.** v4 returns article requests with their live
  status and rejection reason, so there is nothing to sync — the list is current.
- **Tracking target now works.** v3 had no endpoint for it; v4 sets it through
  `PATCH /campaigns` with `traffic.trackingTarget`.

One v3 feature has no v4 equivalent: `link_external_article`, for registering a
self-hosted article. It was never wired to the UI, so nothing was lost.

## Compliance

Five tabs, matching the Tonic dashboard:

- **Ad IDs** — allowed/declined per ad with Tonic's reason, revenue and last check.
  "Immediate action required" filters to declined ads still earning, which are the
  ones costing money. Declined ads without an open request get a **Request review**
  action (`POST /compliance/adIds/reviewRequest`, message 10–500 characters).
- **Site IDs** — two lists: detected in your own traffic, and blocked network-wide.
- **Changelog** — status transitions, manual and automatic. Tonic caps the range at 3 days.
- **Traffic Check** — network clicks against redirects Tonic actually recorded.
  The deviation percentage is computed here, not returned by the API; below −10%
  it is highlighted, since that means paid clicks are not arriving.
- **Missing Parameters** — campaigns not passing required URL parameters, with a
  per-parameter breakdown of what is missing or invalid and for how many days.

## Search

Both search boxes query **Tonic**, not the rows already on screen — so a match on
page nine is still found. Input is debounced, and a campaign-name filter needs at
least 3 characters because v4 rejects anything shorter.

One box covers several filters, chosen from what you type, because v4 has a
separate parameter for each identifier:

| You type | Campaigns | Compliance |
|---|---|---|
| text | `campaignName` | `campaignName`, or `site` on Site IDs |
| short digits | `campaignIds` | `campaignIds` / `campaignId` |
| ~12+ digits | — | `adIds` / `adId` |

Ad IDs are around 18 digits and campaign IDs are short, which is what separates
them. The box says which filter it used ("Matching on Ad ID") so the guess is
never silent.

Traffic Check has no search — v4 exposes no query filter for it. On Site IDs,
only the detected list is searchable; the enforced list takes no parameters.

## Not built yet

The API supports more than this app uses. Nothing below is wired up:
conversion pixels (Taboola / Outbrain / Yahoo / Facebook / TikTok / Google),
global (account-level) callbacks, the account-wide Keywords tab, per-country
stats (`rsoc/stats_by_country`), click-level EPC detail,
`link_external_article` for self-hosted articles, and campaign rename / stop.
