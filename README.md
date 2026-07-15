# @logspot/web

Logspot SDK for browser applications built with React, Next.js, Angular, etc.

## Installation

`npm install @logspot/web`

or

`yarn add @logspot/web`

## Usage

### Init

```js
import Logspot from "@logspot/web";

Logspot.init({ publicKey: "YOUR_PUBLIC_KEY", cookiesDisabled: true });
```

- `publicKey` - project public key
- `cookiesDisabled` - use this property to disable cookie persistence (anonymous id falls back to localStorage / in-memory)
- `enableAutoPageviews` - enable auto tracking of pageviews, including SPA route changes (default: true)
- `legacySpaDetection` - fall back to the legacy MutationObserver-based SPA route detection instead of the default History-API method (default: false; see [Single-page apps](#single-page-apps-spa-pageviews))
- `stickyCampaigns` - enable storing UTM parameters in cookies (default: true)
- `stickyCampaignsExpirationInSeconds` - timeout for sticky campaigns (default: 7 days)
- `enableAutoClicks` - enable auto capture of user clicks (default: false)
- `externalApiUrl` - provide here API proxy url for the track endpoint (e.g. `https://api.example.com/i`)
- `identifyApiUrl` - optional override for the identify endpoint. If omitted and `externalApiUrl` ends in `/i` or `/track`, the SDK derives `/identify` from the same origin; otherwise defaults to `https://api.logspot.io/identify`
- `onLoad` - use this function to perform actions when Logspot is loaded. E.g. register super properties before initial pageview

### Track

```js
Logspot.track({
  event: "UserSubscribed",
  channel: "Sign ups",
  notify: true,
  message: "john@doe.com has subscribed",
  userId: "john@doe.com",
  metadata: { additionalData: "123" },
});
```

### Pageview

```js
Logspot.pageview({
  userId: "john@doe.com",
  metadata: { additionalData: "123" },
});
```

### Single-page apps (SPA pageviews)

With `enableAutoPageviews` on (the default), the SDK tracks client-side route
changes in single-page apps as additional pageviews. Detection uses the History
API: it patches `history.pushState` / `history.replaceState` and listens for
`popstate` (back/forward) and `hashchange` (hash routers). A route change whose
resulting URL is unchanged is ignored, so a `replaceState` that only normalizes
the URL does not double-count. The patched history methods are restored on
`reset()`.

This is **core behavior**, independent of [Autocapture](#autocapture) — it works
whether autocapture is on or off. Set `legacySpaDetection: true` to fall back to
the older MutationObserver heuristic if you depend on it.

### Register

```js
Logspot.register({
  email: "john@doe.com",
  authenticated: true,
  project: "SuperStartup",
});
```

### Identify

Associate the current anonymous browser session with a known user. Subsequent
`track()` and `pageview()` calls include both the `anonymous_id` and the
identified `user_id`.

```js
await Logspot.identify("user_123", {
  email: "user@example.com",
  plan: "pro",
});
```

With Secure Mode (server-issued JWT verifying the user id):

```js
const result = await Logspot.identify(
  "user_123",
  { email: "user@example.com" },
  { identityVerification: { token: jwtFromYourBackend } }
);

if (!result.ok) {
  // result.status / result.reason indicate why (e.g. 401 / "invalid_token")
}
```

### Reset

Clear registered super-properties, drop the identified user, and rotate the
`anonymous_id`. Use on logout. Does not call the network.

```js
Logspot.reset();
```

## Autocapture

Autocapture lets you collect common interactions without writing per-element
tracking code. It is **off by default** and privacy-first: it never records what
people type, form-field values, or sensitive inputs, and autocaptured events
flow through the same consent pipeline as every other event.

### Capture types

When autocapture is enabled, each type can be toggled independently:

| Type | Event name | Metadata | Default (when autocapture on) |
|---|---|---|---|
| `outboundLinks` | `Outbound Link` | `{ href, text }` | on |
| `fileDownloads` | `File Downloaded` | `{ href, fileName, fileExtension }` | on |
| `formSubmissions` | `Form Submitted` | `{ id, name, action }` (never field values) | on |
| `clicks` | `Click` | `{ tag, id, text, href }` | off (noisy) |
| `inputChanges` | `Input Changed` | `{ name, type }` (never the value) | off |
| `mediaPlayback` | `Media Played/Paused/Progress/Completed` | `{ src, duration, current_time, percent }` (never a recording) | off |

File downloads fire on a click of an `<a href>` that either carries a
`download` attribute or whose URL ends in a known download extension. The
built-in default list is
`pdf, zip, csv, xlsx, doc, docx, ppt, pptx, dmg, pkg, mp3, mp4, wav`; your
project's dashboard can override it (the server-provided list **replaces** the
defaults). Matching is case-insensitive and ignores a leading dot.

### Enabling autocapture (npm)

```js
Logspot.init({ publicKey: "YOUR_PUBLIC_KEY", autocapture: true });

// or per-type:
Logspot.init({
  publicKey: "YOUR_PUBLIC_KEY",
  autocapture: { outboundLinks: true, fileDownloads: true, formSubmissions: false },
});
```

### Enabling autocapture (CDN snippet)

The CDN wrapper (`logspot-js`, served as `lg.js`) reads `data-*` attributes off
the `<script>` tag:

| Attribute | Effect |
|---|---|
| `data-autocapture` | master toggle (`true` / `false`) |
| `data-autocapture-outbound` | toggle outbound-link capture |
| `data-autocapture-downloads` | toggle file-download capture |
| `data-autocapture-forms` | toggle form-submission capture |
| `data-autocapture-clicks` | toggle generic element-click capture |
| `data-autocapture-inputs` | toggle input-change capture |

```html
<script
  src="https://cdn.logspot.io/lg.js"
  data-logspot-pk="YOUR_PUBLIC_KEY"
  data-autocapture="true"
  data-autocapture-forms="false"
></script>
```

`data-autocapture` is the **master** switch — it (or the dashboard) is what turns
autocapture on or off. A per-type `data-autocapture-<type>` attribute overrides
that one type (on *or* off) but does **not** by itself enable autocapture: a bare
`data-autocapture-forms="false"` on a project whose dashboard setting is *off*
leaves autocapture off. To turn autocapture on, set `data-autocapture` (or enable
it in the dashboard).

### Configuration precedence

The dashboard sets your project defaults; the snippet overrides any setting it
names; **enabling requires the master**. Concretely:

- **Master (enablement)** resolves as
  `data-autocapture (if set) ?? server "enabled" ?? off`.
  A bare per-type attribute does not participate in enablement.
- **Per-type** (applies only once the master is on) resolves **per key**, snippet
  winning both directions:

  ```
  effective(type) = snippet data-autocapture-<type> (if set) ?? server config ?? built-in default
  ```

`outboundLinks`, `fileDownloads`, and `formSubmissions` are server-configurable;
`clicks` and `inputChanges` are snippet-only. If no config enables autocapture at
all, it stays **off** — core pageview tracking is independent and unaffected.

### Declarative events (`data-lgspt-*`)

Tag any element to fire a named event on click, with optional metadata props.
This works whenever autocapture is enabled and takes precedence over the
built-in capture types:

```html
<button
  data-lgspt-event="Upgrade Clicked"
  data-lgspt-prop-plan="pro"
  data-lgspt-prop-source="hero"
>
  Upgrade
</button>
```

- `data-lgspt-event="<Event Name>"` — the event name to emit on click. The
  handler walks up to the nearest ancestor carrying the attribute.
- `data-lgspt-prop-<key>="<value>"` — each becomes a metadata key/value.

### Legacy `lgspt-` class clicks

For backwards compatibility, a click on any element whose class carries the
`lgspt-` prefix emits an event named after that class (e.g.
`class="lgspt-imagine-cta"` → `Imagine Cta`). This listener is **always on**,
independent of autocapture — it fires even when autocapture is off. Prefer the
declarative `data-lgspt-event` attribute above for new markup; the class-based
path remains only so existing `lgspt-*` markup keeps working unchanged.

### Sensitive data

- Form submissions and input-change events capture **metadata only** — never the
  field values.
- Inputs marked sensitive are skipped entirely: `type="password"`, fields with
  `autocomplete` of `one-time-code` / `current-password` / `new-password` /
  `cc-*`, and any element (or ancestor) carrying `data-lgspt-sensitive`.

### Anonymous ID storage

On init the SDK ensures an `anonymous_id` exists, persisted with this chain:

1. First-party cookie `lgspt_anonymous_id`
2. Legacy SDK cookie `lgspt_uid` (read-only migration source)
3. `localStorage` key `lgspt_anonymous_id`
4. In-memory fallback

You can read the current value via `Logspot.getAnonymousId()`.

## Browser storage reference

All keys are first-party (set on the customer's domain, not `logspot.io`).
Cookie domain is configurable via `cookieDomain`.

| Key | Where | Default TTL | Purpose | Set when |
|---|---|---|---|---|
| `lgspt_anonymous_id` | cookie | 1 year (override: `cookieExpirationInSeconds`) | anonymous browser id sent on every track/identify | `init()` |
| `lgspt_anonymous_id` | localStorage | persistent | fallback for the anonymous id when cookies are unavailable or `cookiesDisabled: true` | `init()` |
| `lgspt_uid` | cookie | — (read-only) | legacy anonymous id from SDK ≤5.1.x; migrated into `anonymous_id` on first init by ≥5.2.0 | not written by this SDK |
| `lgspt_p` | cookie | 30 days | base64-encoded JSON of registered super-properties, merged into every event | `register()` |
| `lgspt_c` | cookie | 7 days (override: `stickyCampaignsExpirationInSeconds`) | base64-encoded JSON of sticky UTM/campaign params | first pageview when `stickyCampaigns: true` |
| `lgspt_ft` | cookie | 1 year | base64-encoded JSON of durable first-touch attribution (UTM/click-ids, external referrer, landing url); set once, never overwritten; sent as `first_touch` inside `identify()` traits | first visit carrying a campaign param or external referrer |
| `lgspt_consent` | cookie (localStorage/in-memory fallback) | 1 year | current consent snapshot (categories, privacy signals, source) stamped on every event | first consent snapshot (CMP adapter, `setConsent()`, or Google Consent Mode read) |
| `lgspt_cfg_<publicKey>` | localStorage | 24h freshness window | cached per-project remote config (autocapture settings) delivered on track responses | first successful track response |
| `lgspt_acov_<publicKey>` | localStorage | persistent | fingerprint of the last reported snippet-override set (dashboard "overridden by snippet" flag) | when the snippet overrides dashboard autocapture settings |
| `lgspt_dnt` | localStorage | persistent | explicit opt-out marker; while present, no events are sent | visiting any page with `?dnt` in the query string |

### Disabling persistence

- `cookiesDisabled: true` — the SDK skips cookie writes entirely. The anonymous
  id falls back to localStorage, then to in-memory if localStorage is also
  unavailable. Other cookies (`lgspt_p`, `lgspt_c`) are simply not written.
- `?dnt` in the URL or `enableBrowserDNT: true` (with browser DNT on) — the SDK
  no-ops on every track/identify call for this visitor.

### Consent

This release ships a granular consent layer alongside the binary `lgspt_dnt`
flag:

- `setConsent({ analytics, functional, marketing, doNotSellShare })` /
  `getConsent()` manage an explicit snapshot (source `logspot_api`, highest
  priority).
- `consentSources: ["concord", "onetrust", "usercentrics", "cookiebot", "gcm"]`
  registers read-only CMP adapters that mirror the vendor banner's state and
  subscribe to its change events.
- `consentBehavior` controls egress: `notRequired` (default) always sends and
  lets the server enforce; `implied` sends until analytics is explicitly
  denied; `express` queues events in memory (max 100) until analytics is
  explicitly granted, and drops the queue on denial.
- Browser privacy signals (Global Privacy Control, GPP presence/string) are
  detected at init and merged into every snapshot; every track/identify payload
  is stamped with `privacy_categories` / `privacy_signals` / `consent_source`,
  and accepted snapshot changes are pushed to `POST /consent` once per change.

### URL privacy (query-param stripping)

- `stripQueryParams: true` removes non-allow-listed query params and the hash
  from the event `url` and `referrer` (and any URL the SDK reports, e.g. the
  snippet-override sample url and first-touch urls) before sending.
- `queryParamAllowlist: string[]` overrides the kept params (default: UTM
  params incl. `utm_id`, ad click-ids, `ref`; exported as
  `DEFAULT_QUERY_PARAM_ALLOWLIST`).
- CDN equivalents: `data-strip-query-params`, `data-query-param-allowlist`.
- This is defense-in-depth; the server strips authoritatively regardless.

## Migration notes (5.2.0)

- `track()` payloads now send `anonymous_id` and `user_id` as separate fields.
  Anonymous-only traffic sends `user_id: null`. Previously the legacy
  `lgspt_uid` was sent as `user_id`; it is now migrated into `anonymous_id`.
- New `identify()` and `reset()` APIs (see above).
- `cookieExpirationInSeconds` no longer leaks into the campaign cookie's TTL.
  Use `stickyCampaignsExpirationInSeconds` to extend the attribution window
  (defaults to 7 days). Previously the campaign cookie inherited
  `cookieExpirationInSeconds` when set — likely unintended for most callers.
- `tsconfig` `target` bumped from `es5` to `es2017`. If you bundle the
  un-transpiled output for very old browsers, re-transpile downstream.
