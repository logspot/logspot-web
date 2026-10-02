import { ensureAnonymousId, rotateAnonymousId } from "./anonymous-id";
import {
  buildSnippetOverrideReport,
  resolveAcOverridesToReport,
} from "./ac-overrides";
import {
  ConsentResult,
  groupUser,
  identifyUser,
  IdentifyOptions,
  IdentifyResult,
  postConsent,
  trackEvent,
} from "./api";
import { Campaign, CAMPAIGN_KEYWORDS } from "./campaign";
import { listenToClassClicks } from "./class-listener";
import {
  ConsentCategory,
  ConsentSnapshot,
  ConsentStore,
} from "./consent";
import {
  ConsentSourceRegistry,
  instantiateConsentSources,
} from "./consent-sources";
import {
  normalizeSnippet,
  resolveEffectiveAutocaptureConfig,
  setupAutocapture,
} from "./autocapture";
import { ONE_YEAR_IN_SECONDS } from "./cookie";
import { hasBrowserDNT, hasExplicitDNT as hasExplicitDNT } from "./dnt";
import { detectPrivacySignals, subscribeGpp } from "./privacy-signals";
import { readRemoteConfig } from "./remote-config";
import { SdkConfig } from "./sdk-config";
import { Properties, SuperProperties } from "./super-properties";
import { stripUrl } from "./url-privacy";
import { removeQueryParamsFromUrl } from "./utils";

// Re-export public config types so consumers (e.g. the CDN wrapper) can import
// them from the package entrypoint.
export type {
  AutocaptureConfig,
  AutocaptureSnippetConfig,
  ConsentBehavior,
  EventPayload,
  SdkConfig,
} from "./sdk-config";
export { DEFAULT_QUERY_PARAM_ALLOWLIST } from "./url-privacy";

const DEFAULT_CONFIG: Omit<SdkConfig, "publicKey"> = {
  cookiesDisabled: false,
  enableAutoPageviews: true,
  enableAutoClicks: false,
  stickyCampaigns: false,
  consentBehavior: "notRequired",
  stripQueryParams: false,
  legacySpaDetection: false,
};

/** Public argument shape for `setConsent()` — all fields optional (partial). */
export type SetConsentInput = {
  analytics?: boolean;
  functional?: boolean;
  marketing?: boolean;
  doNotSellShare?: boolean;
};

/** Internal representation of an event queued under express mode. */
type QueuedEvent = {
  event: string;
  channel?: string | null;
  userId?: string;
  message?: string;
  notify?: boolean;
  metadata?: Record<string, any>;
  // Optional group/account association (Segment `$groups` style).
  groupId?: string;
  groupType?: string;
  // Revenue: monetary amount in MAJOR units + ISO-4217 currency. Set by
  // `revenue()`; absent on ordinary events.
  value?: number;
  currency?: string;
  // Queue-time page context, so an SPA navigation while the CMP banner is
  // open does not re-attribute queued events to the flush-time route.
  url?: string;
  referrer?: string;
  // Queue-time anonymous id, so a reset() mid-flush does not attribute the
  // remaining queued events to the rotated identity.
  anonymousId?: string;
};

// Express-queue cap (drop-oldest) so a session that never resolves consent
// cannot grow the queue unboundedly.
const MAX_PENDING_EVENTS = 100;

/** Default reserved event name marking an event as revenue (server-default). */
const DEFAULT_REVENUE_EVENT_NAME = "Payment";

/** Options for `revenue()`. `currency` is ISO-4217; the rest become metadata. */
export type RevenueOptions = {
  currency?: string;
  /** Override the reserved revenue event name (defaults to "Payment"). */
  event?: string;
  channel?: string | null;
  userId?: string;
  [key: string]: any;
};

const Logspot = () => {
  let sdkConfig: SdkConfig;
  let disableTracking: boolean;

  let getPageViewPayload: () => {
    hostname: string;
    screen: string;
    language: string;
  };

  let currentUrl: string;
  let currentRef: string;
  let identifiedUserId: string | null = null;
  let lastIdentityVerification: { token: string } | null = null;
  let anonymousId: string;
  let superProperties: SuperProperties;
  let campaign: Campaign;
  let consentStore: ConsentStore;
  // Registry of configured consent sources (CMP adapters / GCM reader). Null
  // when `consentSources` is unset, so default behavior is unchanged.
  let consentSourceRegistry: ConsentSourceRegistry | null = null;
  // Express-mode in-memory queue: events captured before the first consent
  // snapshot exists are held here, then flushed (or dropped) once one arrives.
  let pendingEvents: QueuedEvent[] = [];
  // Teardown for the delegated autocapture listeners; re-run on the next init
  // before re-wiring. `reset()` is identity-only and leaves listeners armed.
  let teardownAutocapture: (() => void) | null = null;
  // Teardown for the always-on legacy `lgspt-` classname click listener.
  let teardownClassClicks: (() => void) | null = null;
  // Teardown for SPA route-change detection (History-API patches +
  // popstate/hashchange, or the legacy MutationObserver).
  let teardownSpaPageviews: (() => void) | null = null;
  // Serialized snapshot of the currently-applied effective autocapture config,
  // so re-applying (after a fresh server config arrives) is a no-op when the
  // resolved config is unchanged. `undefined` = never applied yet.
  let appliedAutocaptureKey: string | undefined;
  // Browser-detected privacy signals (GPC/GPP), captured once at init and
  // unioned into every accepted snapshot so a CMP snapshot cannot wipe them.
  let detectedSignals: ReturnType<typeof detectPrivacySignals> = {};
  // Wire key of the last snapshot pushed to /consent (dedup for re-applies).
  let lastPostedConsentKey: string | null = null;
  let teardownReadyListener: (() => void) | null = null;
  let teardownGpp: (() => void) | null = null;

  const getStorageOpts = () => ({
    cookiesDisabled: !!sdkConfig?.cookiesDisabled,
    cookieDomain: sdkConfig?.cookieDomain ?? null,
    cookieExpirationInSeconds:
      sdkConfig?.cookieExpirationInSeconds ?? ONE_YEAR_IN_SECONDS,
  });

  /** Whether the SDK should hold events until analytics is explicitly granted. */
  const isExpressMode = () => sdkConfig?.consentBehavior === "express";

  /** Whether the SDK sends until analytics is explicitly denied. */
  const isImpliedMode = () => sdkConfig?.consentBehavior === "implied";

  const consentPostKey = (snapshot: ConsentSnapshot | null): string | null =>
    snapshot
      ? JSON.stringify({
          c: snapshot.categories,
          s: snapshot.signals,
          src: snapshot.source,
        })
      : null;

  /** Union browser-detected GPC/GPP into the authoritative snapshot. */
  const mergeDetectedSignalsIntoStore = () => {
    const current = consentStore?.get();
    if (!current || Object.keys(detectedSignals).length === 0) {
      return;
    }
    // Browser signals (gpc/gpp) win over the CMP and it cannot un-assert them;
    // the CMP's doNotSellShare survives (detectedSignals never carries it).
    const merged = { ...current.signals, ...detectedSignals };
    if (JSON.stringify(merged) !== JSON.stringify(current.signals)) {
      consentStore.mergeSnapshot({ signals: merged }, current.source);
    }
  };

  /** POST the authoritative snapshot to /consent, deduped on its wire key. */
  const pushConsentIfChanged = async (verification?: {
    token: string;
  }): Promise<ConsentResult> => {
    const snapshot = consentStore?.get();
    if (!snapshot) {
      return { ok: true, reason: "no_snapshot" };
    }
    const key = consentPostKey(snapshot);
    if (key === lastPostedConsentKey) {
      return { ok: true, reason: "unchanged" };
    }
    // Set optimistically so a concurrent apply dedups, but roll back on failure
    // so a transient error does not permanently lose the compliance record.
    const prevKey = lastPostedConsentKey;
    lastPostedConsentKey = key;
    const result = await postConsent(sdkConfig, {
      anonymousId,
      userId: identifiedUserId,
      snapshot,
      identityVerification:
        verification ?? lastIdentityVerification ?? undefined,
    });
    if (!result.ok && lastPostedConsentKey === key) {
      lastPostedConsentKey = prevKey;
    }
    return result;
  };

  const init = async (config: SdkConfig) => {
    if (typeof window === "undefined") {
      throw new Error("Logspot - script needs access to window object");
    }

    disableTracking =
      hasExplicitDNT() || (!!config.enableBrowserDNT && hasBrowserDNT());

    if (disableTracking) {
      return;
    }

    sdkConfig = {
      ...DEFAULT_CONFIG,
      ...config,
    };

    // A re-init belongs to a new config: drop any queue held under the prior
    // one so switching away from express mode can't strand events forever.
    pendingEvents = [];

    superProperties = new SuperProperties(sdkConfig);
    campaign = new Campaign(sdkConfig);

    const {
      screen: { width, height },
      navigator: { language },
      location: { hostname, pathname, search, hash },
      document,
    } = window;

    const screen = `${width}x${height}`;

    // Keep the hash so hash-router landing routes match SPA route-change urls.
    currentUrl = `${pathname}${search}${hash}`;
    currentRef = document.referrer;
    anonymousId = ensureAnonymousId(getStorageOpts());
    consentStore = new ConsentStore(getStorageOpts());
    // A persisted snapshot was already pushed to /consent in a prior session;
    // seed the dedup key so re-applying it does not re-POST every page load.
    lastPostedConsentKey = consentPostKey(consentStore.get());

    // Record browser privacy signals (GPC/GPP) once; they are unioned into
    // every accepted snapshot (never creating one, so express still queues).
    detectedSignals = detectPrivacySignals();
    mergeDetectedSignalsIntoStore();
    // Async GPP hosts surface their string after init; keep the union fresh.
    // Tear down a prior subscription first so a re-init does not stack them.
    teardownGpp?.();
    teardownGpp = subscribeGpp(({ detected, gppString }) => {
      if (!detected) return;
      detectedSignals = {
        ...detectedSignals,
        gppDetected: true,
        ...(gppString ? { gppString } : {}),
      };
      mergeDetectedSignalsIntoStore();
    });

    // Register configured consent sources (CMP adapters / GCM reader). Each
    // source reads its vendor's current state and subscribes for changes; every
    // snapshot is funneled through `applyConsentSnapshot`, where the store
    // enforces the priority ladder. When `consentSources` is unset this is a
    // no-op, so default behavior is byte-identical.
    // A re-init must not leave a previously-configured registry live.
    consentSourceRegistry?.stop();
    consentSourceRegistry = null;
    const sourceNames = sdkConfig.consentSources ?? [];
    if (sourceNames.length > 0) {
      consentSourceRegistry = new ConsentSourceRegistry(
        instantiateConsentSources(sourceNames),
        applyConsentSnapshot
      );
      consentSourceRegistry.start();
    }

    getPageViewPayload = () => {
      return {
        hostname,
        screen,
        language,
      };
    };

    if (sdkConfig.onLoad) {
      await sdkConfig.onLoad();
    }

    // Normalize a full/relative href into the path form the SDK tracks (e.g.
    // "http://host/a/b?x" → "/a/b?x"). Mirrors the historical normalization.
    const normalizeUrl = (href: string): string => {
      if (href.substring(0, 4) === "http") {
        return "/" + href.split("/").splice(3).join("/");
      }
      return href;
    };

    // Handle a detected route change: dedupe against the last-tracked URL (so a
    // `replaceState` that only normalizes the URL doesn't double-count), advance
    // referrer + current URL, then fire a pageview (gated on enableAutoPageviews,
    // reusing the existing referrer-tracking).
    const handleRouteChange = () => {
      const nextUrl = normalizeUrl(document.location.href);
      // Dedupe: ignore a route change whose resulting URL is unchanged.
      if (nextUrl === currentUrl) {
        return;
      }
      currentRef = currentUrl;
      currentUrl = nextUrl;
      if (sdkConfig.enableAutoPageviews) {
        pageview();
      }
    };

    /**
     * SPA route-change detection. Default (History-API): patch `pushState` /
     * `replaceState` to emit a route-change signal, and listen to `popstate`
     * (back/forward) + `hashchange` (hash routers). The History-API patches are
     * restored on teardown. When `legacySpaDetection` is set, fall back to the
     * old MutationObserver-on-body heuristic instead. Returns a teardown.
     */
    const setupSpaPageviews = (): (() => void) => {
      if (sdkConfig.legacySpaDetection) {
        // Legacy heuristic: watch body mutations and re-check the URL. Kept
        // behind the flag for sites that depend on the old behavior.
        const bodyList = document.querySelector("body");
        if (!bodyList) return () => {};
        const observer = new MutationObserver(() => {
          handleRouteChange();
        });
        observer.observe(bodyList, { childList: true, subtree: true });
        return () => observer.disconnect();
      }

      // History-API detection (default). `pushState`/`replaceState` don't emit
      // any event, so we patch them to notify; `popstate`/`hashchange` cover
      // back/forward and hash routers. We save whatever `pushState` currently is
      // and call THROUGH it, so we coexist with other libraries that also patch
      // history (e.g. SPA routers).
      const originalPushState = history.pushState;
      const originalReplaceState = history.replaceState;

      const onPopState = () => handleRouteChange();
      const onHashChange = () => handleRouteChange();

      const patchedPushState = function (
        this: History,
        ...args: Parameters<History["pushState"]>
      ) {
        const result = originalPushState.apply(this, args);
        handleRouteChange();
        return result;
      };
      const patchedReplaceState = function (
        this: History,
        ...args: Parameters<History["replaceState"]>
      ) {
        const result = originalReplaceState.apply(this, args);
        handleRouteChange();
        return result;
      };
      history.pushState = patchedPushState;
      history.replaceState = patchedReplaceState;

      window.addEventListener("popstate", onPopState);
      window.addEventListener("hashchange", onHashChange);

      return () => {
        // Only restore if no one patched ON TOP of us; otherwise leave the chain
        // intact so we don't clobber another library's history patch.
        if (history.pushState === patchedPushState) {
          history.pushState = originalPushState;
        }
        if (history.replaceState === patchedReplaceState) {
          history.replaceState = originalReplaceState;
        }
        window.removeEventListener("popstate", onPopState);
        window.removeEventListener("hashchange", onHashChange);
      };
    };

    const update = () => {
      if (document.readyState === "complete") {
        // SPA route detection exists solely to fire auto-pageviews, so only set
        // it up (and patch global history) when auto-pageviews are enabled. Set
        // up exactly once; `teardownSpaPageviews` guards the re-running listener.
        if (sdkConfig.enableAutoPageviews) {
          pageview();
          if (!teardownSpaPageviews) {
            teardownSpaPageviews = setupSpaPageviews();
          }
        }
      }
    };

    // Re-init must not stack a second listener (double initial Pageview).
    teardownReadyListener?.();
    document.addEventListener("readystatechange", update, true);
    teardownReadyListener = () =>
      document.removeEventListener("readystatechange", update, true);
    update();

    // Legacy `lgspt-` classname click listener. Attached UNCONDITIONALLY on
    // every init (independent of autocapture), preserving the pre-existing
    // behavior: a click on an element whose class carries the `lgspt-` prefix
    // emits an event named after that class. It fires even when autocapture is
    // OFF, and coexists with the declarative `data-lgspt-event` path (handled in
    // autocapture.ts) — they fire on different markers and do not interfere.
    // Re-init must not stack a second document listener (double-fired clicks).
    teardownClassClicks?.();
    teardownClassClicks = listenToClassClicks(({ name }) =>
      track({ event: name, channel: sdkConfig.pageviewsChannel ?? null })
    );

    // Delegated autocapture. The effective config is merged
    // per-key as `snippet ?? server ?? default`: the snippet (`data-autocapture*`
    // / init option) wins for any key it sets, else the server config cached on
    // the public key, else the built-in defaults. When neither the snippet nor
    // the server enables autocapture this resolves to null and nothing is
    // attached (fail-safe OFF).
    applyAutocapture();
  };

  /**
   * Compute the effective autocapture config (snippet ?? server ?? default) and
   * (re)attach the delegated listeners. Idempotent: tears down any existing
   * listeners first, so it is safe to call again when a fresher server config
   * arrives on a track response. When autocapture resolves OFF, this leaves no
   * listeners attached (fail-safe), and core pageview tracking is unaffected.
   */
  const applyAutocapture = () => {
    if (!sdkConfig || disableTracking) {
      return;
    }

    const remote = readRemoteConfig(sdkConfig.publicKey);
    const autocaptureConfig = resolveEffectiveAutocaptureConfig(
      sdkConfig.autocapture,
      sdkConfig.enableAutoClicks,
      remote
    );

    // No-op when the resolved config is identical to what's already attached
    // (avoids tearing down + re-binding listeners on every track response).
    const nextKey = JSON.stringify(autocaptureConfig);
    if (nextKey === appliedAutocaptureKey) {
      return;
    }
    appliedAutocaptureKey = nextKey;

    // Detach any previously-attached listeners before re-wiring.
    teardownAutocapture?.();
    teardownAutocapture = null;

    if (autocaptureConfig) {
      teardownAutocapture = setupAutocapture({
        config: autocaptureConfig,
        shouldTrack: () => !disableTracking,
        track: ({ event, metadata }) =>
          track({
            event,
            channel: sdkConfig.pageviewsChannel ?? null,
            metadata,
          }),
      });
    }
  };

  const track = async (data: {
    event: string;
    channel?: string | null;
    userId?: string;
    message?: string;
    notify?: boolean;
    metadata?: Record<string, any>;
    value?: number;
    currency?: string;
    /** Associate this event with a group/account (Segment `$groups` style).
     *  With groupType "company" (the default when groupId is set) the platform
     *  resolves and stamps the company on the event. */
    groupId?: string;
    groupType?: string;
  }) => {
    if (!sdkConfig || disableTracking) {
      return;
    }

    if (!sdkConfig.externalApiUrl && !sdkConfig.publicKey) {
      console.error(
        "Logspot - SDK not configured. You need to call: Logspot.init({publicKey: 'YOUR_PUBLIC_KEY'})"
      );
      return;
    }

    if (data.value != null && data.value !== 0 && !data.currency) {
      console.warn(
        "Logspot - payment sent without a currency. Revenue reports leave it out unless the project counts payments without a currency. Pass currency, e.g. { currency: 'USD' }."
      );
    }

    const analytics = consentStore?.get()?.categories.analytics;

    // Express: send ONLY on an explicit analytics grant; an unknown/partial
    // snapshot queues (same predicate as flushPendingEvents).
    if (isExpressMode()) {
      if (analytics === true) {
        await sendEvent(data);
        return;
      }
      if (analytics === false) {
        return;
      }
      if (pendingEvents.length >= MAX_PENDING_EVENTS) {
        pendingEvents.shift();
      }
      pendingEvents.push({
        ...data,
        url: currentUrl,
        referrer: currentRef,
        anonymousId,
      });
      return;
    }

    // Implied: send until analytics is explicitly denied. `notRequired` (the
    // default) always sends and lets the server enforce.
    if (isImpliedMode() && analytics === false) {
      return;
    }

    await sendEvent(data);
  };

  /**
   * Compute the observed snippet-override report to attach to the next track
   * request, if any. Derives the EXPLICIT snippet override set from the same
   * normalization the autocapture resolver uses, then defers to the localStorage
   * dedup in `ac-overrides.ts`: returns a report only when the override set
   * differs from the last one reported for this public key (or, in the CLEAR
   * case, once after the overrides are removed). Best-effort — any failure
   * yields null so tracking is never affected.
   */
  const computeAcOverridesReport = () => {
    try {
      const normalized = normalizeSnippet(sdkConfig.autocapture);
      const report = buildSnippetOverrideReport(
        normalized,
        sdkConfig.enableAutoClicks
      );
      // Sample URL where observed (no hash needed). Best-effort. Honors the
      // url-privacy toggle: this field crosses the wire like any event url.
      let url: string | null = null;
      try {
        const href = window.location.href;
        url = href ? href.split("#")[0] : null;
        if (url && sdkConfig.stripQueryParams) {
          url = stripUrl(url, sdkConfig.queryParamAllowlist) ?? url;
        }
      } catch {
        url = null;
      }
      return resolveAcOverridesToReport({
        publicKey: sdkConfig.publicKey,
        report,
        url,
      });
    } catch {
      return null;
    }
  };

  /**
   * Build the wire payload for one event and send it, stamping the current
   * consent snapshot. Shared by `track()` and the express-mode flush.
   */
  const sendEvent = async (data: QueuedEvent) => {
    const payload = getPageViewPayload();
    const { userId: propsUserId, ...props } = superProperties.getProperties();
    const campaignParams = campaign.getCampaignParams();

    const cleanedUrl = removeQueryParamsFromUrl(
      data.url ?? currentUrl,
      CAMPAIGN_KEYWORDS
    );
    const resolvedUserId =
      data.userId ??
      (propsUserId ? `${propsUserId}` : null) ??
      identifiedUserId ??
      null;

    await trackEvent(
      sdkConfig,
      {
        event: data.event,
        channel: data.channel,
        message: data.message,
        notify: data.notify,
        userId: resolvedUserId,
        anonymousId: data.anonymousId ?? anonymousId,
        groupId: data.groupId,
        groupType: data.groupType,
        hostname: payload.hostname,
        language: payload.language,
        referrer: data.referrer ?? currentRef,
        screen: payload.screen,
        url: cleanedUrl,
        value: data.value,
        currency: data.currency,
        metadata: {
          ...campaignParams,
          ...props,
          ...(data.metadata ?? {}),
        },
      },
      consentStore?.get() ?? null,
      computeAcOverridesReport()
    );

    // The track response may have refreshed the cached per-project config
    // (persisted in api.ts). Re-apply autocapture so a dashboard change takes
    // effect without a page reload. No-ops when the effective config is
    // unchanged.
    applyAutocapture();
  };

  /**
   * Flush the express-mode queue once a snapshot is known. If analytics is
   * explicitly denied in the snapshot, drop the queue instead (the server is
   * the enforcement backstop, but we avoid sending events we know will be
   * dropped). Called after any snapshot change.
   */
  const flushPendingEvents = async () => {
    if (!pendingEvents.length) return;

    const queued = pendingEvents;
    pendingEvents = [];

    // Re-read consent before each send: a higher-priority denial can arrive
    // mid-flush (source callbacks apply synchronously).
    for (let i = 0; i < queued.length; i++) {
      const analytics = consentStore?.get()?.categories.analytics;
      if (analytics === true) {
        await sendEvent(queued[i]);
      } else if (analytics === false) {
        return;
      } else {
        pendingEvents.push(...queued.slice(i));
        return;
      }
    }
  };

  /**
   * Public API: track a revenue event. Thin wrapper over `track()` that emits
   * the reserved revenue event name (default "Payment") with the monetary
   * `value` (MAJOR units, e.g. dollars) and ISO-4217 `currency`. Any other
   * options become event metadata (e.g. product, plan, interval, quantity).
   *
   * For Stripe attribution, pass `logspot.getAnonymousId()` (or the
   * `lgspt_anonymous_id` cookie) into your Stripe Checkout session metadata as
   * `logspot_anonymous_id` so the connected-account webhook can link the payment
   * back to this visitor.
   */
  const revenue = async (amount: number, options: RevenueOptions = {}) => {
    if (!sdkConfig || disableTracking) {
      return;
    }
    if (typeof amount !== "number" || !isFinite(amount) || amount < 0) {
      console.error(
        "Logspot - revenue() requires a finite, non-negative amount"
      );
      return;
    }

    const { currency, event, channel, userId, ...metadata } = options;

    await track({
      event: event ?? DEFAULT_REVENUE_EVENT_NAME,
      channel,
      userId,
      value: amount,
      currency,
      metadata,
    });
  };

  const pageview = async (data?: {
    userId?: string;
    metadata?: Record<string, any>;
  }) => {
    if (!sdkConfig || disableTracking) {
      return;
    }

    await track({
      event: "Pageview",
      channel: sdkConfig.pageviewsChannel ?? null,
      userId: data?.userId,
      metadata: data?.metadata,
    });
  };

  const register = (properties: Properties) => {
    if (!sdkConfig || disableTracking) {
      return true;
    }
    return superProperties.register(properties);
  };

  const getProperties = () => {
    if (!sdkConfig || disableTracking) {
      return {};
    }
    return superProperties.getProperties();
  };

  const unregister = (property: string) => {
    if (!sdkConfig || disableTracking) {
      return;
    }
    superProperties.unregister(property);
  };

  const identify = async (
    newUserId: string,
    traits?: Record<string, any>,
    opts?: IdentifyOptions
  ): Promise<IdentifyResult> => {
    if (!sdkConfig) {
      console.warn("Logspot - identify() called before init()");
      return { ok: false, reason: "not_initialized" };
    }
    if (disableTracking) {
      return { ok: false, reason: "tracking_disabled" };
    }

    const normalizedUserId = `${newUserId ?? ""}`.trim();
    if (!normalizedUserId) {
      console.error("Logspot - identify requires a userId");
      return { ok: false, reason: "missing_user_id" };
    }

    // Deliberately NOT gated on consent: identify is a customer-directed
    // linkage call (legitimate interest); the server gates egress by purpose.
    const firstTouch = sanitizeFirstTouch(campaign.getFirstTouchParams());
    const mergedTraits =
      Object.keys(firstTouch).length > 0
        ? { first_touch: firstTouch, ...traits }
        : traits;

    const result = await identifyUser(
      sdkConfig,
      {
        anonymousId,
        userId: normalizedUserId,
        traits: mergedTraits,
        options: opts,
      },
      consentStore?.get() ?? null
    );

    // Adopt the identity only once the server accepted it, so a rejected
    // Secure-Mode token cannot stamp later events with an unverified user_id.
    if (result.ok) {
      identifiedUserId = normalizedUserId;
      lastIdentityVerification = opts?.identityVerification ?? null;
      superProperties.register({ userId: identifiedUserId });
    }

    return result;
  };

  /**
   * Associate the current visitor with a group/account (Segment `group()`), e.g.
   * a company. Binds to the identified `user_id` when known, otherwise to the
   * managed `anonymousId` (the platform promotes anon memberships to the identity
   * on the next identify). Not gated on consent: a customer-directed linkage call
   * (legitimate interest); the server gates egress by purpose.
   */
  const group = async (
    groupId: string,
    traits?: Record<string, any>,
    opts?: IdentifyOptions & { type?: string }
  ): Promise<IdentifyResult> => {
    if (!sdkConfig) {
      console.warn("Logspot - group() called before init()");
      return { ok: false, reason: "not_initialized" };
    }
    if (disableTracking) {
      return { ok: false, reason: "tracking_disabled" };
    }

    const normalizedGroupId = `${groupId ?? ""}`.trim();
    if (!normalizedGroupId) {
      console.error("Logspot - group requires a groupId");
      return { ok: false, reason: "missing_group_id" };
    }

    return groupUser(sdkConfig, {
      anonymousId,
      userId: identifiedUserId,
      groupId: normalizedGroupId,
      type: opts?.type,
      traits,
      options: opts,
    });
  };

  /** Apply the url-privacy toggle to first-touch urls before they egress. */
  const sanitizeFirstTouch = (
    firstTouch: Record<string, string>
  ): Record<string, string> => {
    if (!sdkConfig?.stripQueryParams) {
      return firstTouch;
    }
    const sanitized = { ...firstTouch };
    for (const key of ["landing_url", "referrer"] as const) {
      if (sanitized[key]) {
        sanitized[key] =
          stripUrl(sanitized[key], sdkConfig.queryParamAllowlist) ??
          sanitized[key];
      }
    }
    return sanitized;
  };

  /**
   * Internal: apply a snapshot from a consent source through the store's
   * priority-aware `applySnapshot`. If accepted (became/stayed authoritative),
   * persists, flushes any express-mode queue, and pushes to `/consent`.
   *
   * This is the internal seam the consent-source plugins write through: a
   * source (Concord/OneTrust/GCM reader/...) constructs a
   * `ConsentSnapshot` with its `source` id and calls this; the store keeps the
   * highest-priority snapshot authoritative.
   *
   * Returns `true` if the snapshot was accepted, `false` if a higher-priority
   * source already owns the state.
   */
  const applyConsentSnapshot = async (
    snapshot: ConsentSnapshot
  ): Promise<boolean> => {
    if (!sdkConfig || disableTracking || !consentStore) {
      return false;
    }

    const accepted = consentStore.applySnapshot(snapshot);
    if (!accepted) {
      return false;
    }
    mergeDetectedSignalsIntoStore();

    await flushPendingEvents();
    await pushConsentIfChanged();
    return true;
  };

  /**
   * Public API: explicit consent (highest-priority source `logspot_api`).
   * Merge-partial update — unspecified categories keep their prior value.
   * Persists, stamps subsequent events, flushes the express queue, and POSTs
   * the new state to `/consent`.
   */
  const setConsent = async (
    input: SetConsentInput,
    opts?: { identityVerification?: { token: string } }
  ): Promise<ConsentResult> => {
    if (!sdkConfig) {
      console.warn("Logspot - setConsent() called before init()");
      return { ok: false, reason: "not_initialized" };
    }
    if (disableTracking) {
      return { ok: false, reason: "tracking_disabled" };
    }

    const categories: Partial<Record<ConsentCategory, boolean>> = {};
    if (typeof input.analytics === "boolean")
      categories.analytics = input.analytics;
    if (typeof input.functional === "boolean")
      categories.functional = input.functional;
    if (typeof input.marketing === "boolean")
      categories.marketing = input.marketing;

    const signals =
      typeof input.doNotSellShare === "boolean"
        ? { doNotSellShare: input.doNotSellShare }
        : {};

    // logspot_api is the top of the priority ladder, so this always wins.
    consentStore.mergeSnapshot({ categories, signals }, "logspot_api");
    mergeDetectedSignalsIntoStore();

    await flushPendingEvents();
    return pushConsentIfChanged(opts?.identityVerification);
  };

  /** Public API: read the current consent snapshot (or null if none yet). */
  const getConsent = (): ConsentSnapshot | null => {
    if (!sdkConfig || disableTracking || !consentStore) {
      return null;
    }
    return consentStore.get();
  };

  // Resets IDENTITY, not tracking: listeners stay armed (logout semantics)
  // and consent sources are re-read so CMP state re-populates the store.
  const reset = () => {
    if (!sdkConfig || disableTracking) {
      return;
    }

    superProperties.clear();
    identifiedUserId = null;
    lastIdentityVerification = null;
    anonymousId = rotateAnonymousId(getStorageOpts());
    consentStore?.clear();
    pendingEvents = [];
    lastPostedConsentKey = null;

    consentSourceRegistry?.stop();
    consentSourceRegistry = null;
    const sourceNames = sdkConfig.consentSources ?? [];
    if (sourceNames.length > 0) {
      consentSourceRegistry = new ConsentSourceRegistry(
        instantiateConsentSources(sourceNames),
        applyConsentSnapshot
      );
      consentSourceRegistry.start();
    }
  };

  /**
   * The current anonymous visitor id. This is the value to pass into your
   * Stripe Checkout session metadata as `logspot_anonymous_id` (it mirrors the
   * `lgspt_anonymous_id` cookie) so Logspot's connected-account webhook can
   * attribute the resulting payment back to this visitor and their account.
   * Returns null when tracking is disabled or the SDK is not initialized.
   */
  const getAnonymousId = () => {
    if (!sdkConfig || disableTracking) {
      return null;
    }
    return anonymousId;
  };

  return {
    init,
    track,
    revenue,
    pageview,
    register,
    unregister,
    reset,
    identify,
    group,
    setConsent,
    getConsent,
    applyConsentSnapshot,
    getProperties,
    getAnonymousId,
  };
};

export const logspot = Logspot();
export default logspot;
