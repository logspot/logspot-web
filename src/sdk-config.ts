export type EventPayload = {
  name: string;
  channel?: string | null;
  message?: string | null;
  notify?: boolean | null;
  user_id?: string | null;
  anonymous_id?: string | null;
  metadata?: any | null;
  hostname?: string | null;
  url?: string | null;
  referrer?: string | null;
  language?: string | null;
  screen?: string | null;
  // Revenue: `value` is the monetary amount in MAJOR units (e.g. dollars);
  // `currency` is an ISO-4217 code. Populated by `revenue()` (or any `track`
  // call that passes them). Omitted on non-revenue events.
  value?: number | null;
  currency?: string | null;
  // Consent stamps. Added by the SDK *after* `eventMapper` runs, so user hooks
  // never see (or accidentally clobber) them. Empty string = "no snapshot yet".
  privacy_categories?: string;
  privacy_signals?: string;
  consent_source?: string | null;
};

/**
 * Mirrors the org-level `consentBehavior` setting. `notRequired` (default)
 * preserves the SDK's existing send-immediately behavior byte-for-byte.
 * `implied` sends until analytics is explicitly denied. `express` queues
 * events until analytics is explicitly granted (denial drops the queue).
 */
export type ConsentBehavior = "notRequired" | "implied" | "express";

/**
 * Per-type autocapture toggles. Each capture type can be enabled/disabled
 * independently. Unset keys fall back to {@link AUTOCAPTURE_DEFAULTS}.
 *
 * - `outboundLinks` — clicks on `<a>` whose host differs from `location.host`
 * - `fileDownloads` — clicks on `<a>` whose href ends in a download extension
 *   (or that carry a `download` attribute); metadata only, no PII
 * - `formSubmissions` — `submit` events (metadata only, never field values)
 * - `clicks` — clicks on interactive elements (noisy; off by default)
 * - `inputChanges` — `change` events on inputs (metadata only; off by default)
 * - `mediaPlayback` — native `<video>`/`<audio>` engagement (play/pause/progress/
 *   complete); metadata only, never a recording. Audience-dependent; off by
 *   default.
 */
export type AutocaptureConfig = {
  outboundLinks?: boolean;
  fileDownloads?: boolean;
  formSubmissions?: boolean;
  clicks?: boolean;
  inputChanges?: boolean;
  mediaPlayback?: boolean;
};

/**
 * Snippet-shaped autocapture config used by the CDN wrapper (`logspot-js`). It
 * separates the **master** enablement (the `data-autocapture` attribute) from
 * per-**type** overrides (`data-autocapture-<type>`), so a bare per-type
 * attribute can override that type *without* force-enabling autocapture.
 *
 * - `master` — `true`/`false` when `data-autocapture` is explicitly set;
 *   `undefined` when only per-type attributes are present (enablement then
 *   defers to the server / dashboard).
 * - `types` — the per-type overrides parsed from `data-autocapture-<type>`.
 *
 * The plain {@link AutocaptureConfig} object form (used by direct `init()`
 * callers) keeps its historical meaning: passing an object enables autocapture.
 * Only this `{ master, types }` shape decouples the two.
 */
export type AutocaptureSnippetConfig = {
  master?: boolean;
  types?: AutocaptureConfig;
};

export interface SdkConfig {
  publicKey: string;
  pageviewsChannel?: string;
  cookiesDisabled?: boolean;
  enableAutoPageviews?: boolean;
  /**
   * Escape hatch: fall back to the legacy MutationObserver-based SPA route
   * detection instead of the default History-API method (patching
   * `pushState`/`replaceState` + `popstate`/`hashchange`). Default `false`.
   * Only relevant when `enableAutoPageviews` is true. The History-API method is
   * more accurate (it does not fire spurious pageviews on unrelated DOM churn
   * and dedupes URL-normalizing `replaceState` calls), so this exists purely as
   * a safety valve for sites that depend on the old heuristic.
   */
  legacySpaDetection?: boolean;
  /**
   * Legacy single-toggle "capture every click" flag. Retained for back-compat:
   * it maps to `autocapture: { clicks: true }`. Prefer `autocapture`.
   */
  enableAutoClicks?: boolean;
  /**
   * Delegated autocapture.
   *
   * - `true` / `false` — master toggle.
   * - {@link AutocaptureConfig} object — enables autocapture and applies the
   *   per-type overrides (direct-`init()` convenience; an object means enable).
   * - {@link AutocaptureSnippetConfig} `{ master, types }` — the snippet form,
   *   which separates master enablement from per-type overrides so a bare
   *   per-type attribute does NOT by itself enable autocapture.
   *
   * Per-type resolution uses {@link AUTOCAPTURE_DEFAULTS}. When unset (and
   * `enableAutoClicks` is false), no autocapture listeners are attached and
   * default behavior is byte-identical.
   */
  autocapture?: boolean | AutocaptureConfig | AutocaptureSnippetConfig;
  externalApiUrl?: string;
  identifyApiUrl?: string;
  /** Override for the `POST /consent` endpoint (pattern of `identifyApiUrl`). */
  consentApiUrl?: string;
  /** Override for the `POST /group` endpoint (pattern of `identifyApiUrl`). */
  groupApiUrl?: string;
  /** Gating behavior for consent. Default `notRequired` (no behavior change). */
  consentBehavior?: ConsentBehavior;
  /**
   * Names of consent sources to register (e.g. `['onetrust', 'gcm']`).
   * Plumbed through from the CDN wrapper's `data-consent-source` attribute; the
   * plugin registry (consent-sources/) consumes these ids.
   */
  consentSources?: string[];
  /**
   * Defense-in-depth URL privacy. When `true`, the SDK removes query params not
   * in {@link queryParamAllowlist} (and always the hash) from BOTH the event url
   * and the referrer before sending, so PII/secrets in the query string never
   * leave the browser. The referrer matters most for SPAs, where it becomes the
   * previous in-app URL on each route change. The server applies the
   * authoritative per-project rule regardless; this only keeps the wire clean.
   * Default `false` (url + referrer sent unchanged). UTM attribution is
   * unaffected (captured from `window.location`, not the payload url).
   */
  stripQueryParams?: boolean;
  /**
   * Query-param names kept on the url when {@link stripQueryParams} is on
   * (case-insensitive). Defaults to UTM params + common ad click-ids + `ref`.
   */
  queryParamAllowlist?: string[];
  stickyCampaigns?: boolean;
  stickyCampaignsExpirationInSeconds?: number;
  cookieDomain?: string;
  cookieExpirationInSeconds?: number;
  enableBrowserDNT?: boolean;
  onLoad?: () => void | Promise<void>;
  eventMapper?: (payload: EventPayload) => EventPayload | Promise<EventPayload>;
}
