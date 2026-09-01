import type { AcOverridesReport } from "./ac-overrides";
import {
  ConsentSnapshot,
  encodeCategories,
  encodeSignals,
} from "./consent";
import { RemoteConfig, writeRemoteConfig } from "./remote-config";
import { EventPayload, SdkConfig } from "./sdk-config";
import { stripUrl } from "./url-privacy";

const API_URL = "https://api.logspot.io";

const deriveEndpoint = (config: SdkConfig, suffix: string): string | null => {
  if (!config.externalApiUrl) return `${API_URL}/${suffix}`;

  try {
    const url = new URL(config.externalApiUrl);
    if (/\/(i|track)\/?$/.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/(i|track)\/?$/, `/${suffix}`);
      return url.toString();
    }
  } catch {
    // Relative or malformed event URLs cannot safely derive the sibling route.
  }

  // Fail closed: a proxy setup we cannot derive a sibling for must not leak
  // the most PII-heavy calls to the default cloud behind the customer's back.
  console.error(
    `Logspot - cannot derive the /${suffix} endpoint from externalApiUrl. ` +
      `Set ${suffix === "identify" ? "identifyApiUrl" : "consentApiUrl"} explicitly.`
  );
  return null;
};

const identifyUrlFromConfig = (config: SdkConfig): string | null => {
  if (config.identifyApiUrl) return config.identifyApiUrl;
  return deriveEndpoint(config, "identify");
};

const consentUrlFromConfig = (config: SdkConfig): string | null => {
  if (config.consentApiUrl) return config.consentApiUrl;
  return deriveEndpoint(config, "consent");
};

const groupUrlFromConfig = (config: SdkConfig): string | null => {
  if (config.groupApiUrl) return config.groupApiUrl;
  return deriveEndpoint(config, "group");
};

/**
 * Apply consent stamps to an event payload. Called *after* the user's
 * `eventMapper` so the stamps are authoritative and never clobbered. When no
 * snapshot exists the stamps default to empty strings ("pre-consent / unknown"),
 * matching the server's legacy-empty handling.
 */
const consentStampFields = (snapshot: ConsentSnapshot | null) =>
  snapshot
    ? {
        privacy_categories: encodeCategories(snapshot.categories),
        privacy_signals: encodeSignals(snapshot.signals),
        consent_source: snapshot.source,
      }
    : {
        privacy_categories: "",
        privacy_signals: "",
        consent_source: null,
      };

const stampConsent = (
  payload: EventPayload,
  snapshot: ConsentSnapshot | null
): EventPayload => ({ ...payload, ...consentStampFields(snapshot) });

export const trackEvent = async (
  config: SdkConfig,
  payload: {
    event: string;
    channel?: string | null;
    message?: string | null;
    notify?: boolean | null;
    userId?: string | null;
    anonymousId?: string | null;
    metadata?: any | null;
    hostname?: string | null;
    url?: string | null;
    referrer?: string | null;
    language?: string | null;
    screen?: string | null;
    value?: number | null;
    currency?: string | null;
    groupId?: string | null;
    groupType?: string | null;
  },
  consentSnapshot?: ConsentSnapshot | null,
  // Optional observed snippet-override report. Rides this track request only
  // when there is something to report (see ac-overrides.ts); null/undefined on
  // every other event. It is config metadata, NOT an event property, so it is
  // attached at the top level of the body, after the user's eventMapper.
  acOverrides?: AcOverridesReport | null
) => {
  if (!payload.event) {
    console.error("Logspot - event parameter is required");
    return;
  }

  try {
    let payloadToSend: EventPayload = {
      name: payload.event,
      channel: payload.channel,
      message: payload.message,
      notify: payload.notify,
      user_id: payload.userId ?? null,
      anonymous_id: payload.anonymousId ?? null,
      metadata: payload.metadata ?? {},
      hostname: payload.hostname,
      url: payload.url,
      referrer: payload.referrer?.length ? payload.referrer : null,
      language: payload.language,
      screen: payload.screen,
      // Only attach revenue fields when present so non-revenue events keep an
      // identical wire shape.
      ...(payload.value != null ? { value: payload.value } : {}),
      ...(payload.currency != null ? { currency: payload.currency } : {}),
      ...(payload.groupId ? { group_id: payload.groupId } : {}),
      ...(payload.groupId
        ? { group_type: payload.groupType || "company" }
        : {}),
    };

    if (config.eventMapper) {
      payloadToSend = await config.eventMapper(payloadToSend);
    }

    // Strip AFTER the eventMapper, like the consent stamps, so a mapper
    // cannot reintroduce params the host asked to remove (url or referrer).
    if (config.stripQueryParams) {
      payloadToSend = {
        ...payloadToSend,
        url: stripUrl(payloadToSend.url, config.queryParamAllowlist),
        referrer: payloadToSend.referrer?.length
          ? stripUrl(payloadToSend.referrer, config.queryParamAllowlist)
          : null,
      };
    }
    // The server's schema rejects referrers over 255 chars, 400ing the event.
    if (payloadToSend.referrer && payloadToSend.referrer.length > 255) {
      payloadToSend = {
        ...payloadToSend,
        referrer: payloadToSend.referrer.slice(0, 255),
      };
    }

    // Stamp consent AFTER the user's eventMapper so it is authoritative.
    payloadToSend = stampConsent(payloadToSend, consentSnapshot ?? null);

    // Attach the observed snippet-override report (if any) at the top level of
    // the body. It is config metadata the server reads to flag overridden
    // dashboard settings; only present when there is something to report.
    const wireBody: EventPayload & { _acOverrides?: AcOverridesReport } =
      acOverrides ? { ...payloadToSend, _acOverrides: acOverrides } : payloadToSend;

    const response = await fetch(
      config.externalApiUrl ? config.externalApiUrl : `${API_URL}/i`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-logspot-pk": config.publicKey,
        },
        mode: "cors",
        // Outbound-link and form-submit events race the page unload.
        keepalive: true,
        body: JSON.stringify(wireBody),
      }
    );

    if (!response.ok) {
      // A 4xx is silent, total event loss otherwise (e.g. a schema rejection).
      console.error("Logspot - track rejected", response.status);
      return;
    }

    // The server piggybacks the per-project `config` on the track response;
    // persist it (keyed by public key) so the next page load can apply it.
    await persistConfigFromResponse(config.publicKey, response);
  } catch (err) {
    console.error("Logspot - could not track event");
  }
};

/**
 * Read the `config` field from a track response and cache it for the public
 * key. Tolerates non-JSON / missing bodies and never throws — config delivery
 * is additive and must never break tracking.
 */
const persistConfigFromResponse = async (
  publicKey: string | undefined,
  response: Response
): Promise<void> => {
  if (!publicKey || !response || !response.ok) return;
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return;
    const config = (body as { config?: unknown }).config;
    if (typeof config === "object" && config !== null) {
      writeRemoteConfig(publicKey, config as RemoteConfig);
    }
  } catch {
    // Empty / non-JSON body, or storage failure — ignore.
  }
};

export type IdentifyOptions = {
  identityVerification?: {
    token: string;
  };
};

export type IdentifyResult = {
  ok: boolean;
  status?: number;
  reason?: string;
};

export const identifyUser = async (
  config: SdkConfig,
  payload: {
    anonymousId: string | null;
    userId: string;
    traits?: Record<string, any>;
    options?: IdentifyOptions;
  },
  consentSnapshot?: ConsentSnapshot | null
): Promise<IdentifyResult> => {
  if (!payload.userId) {
    console.error("Logspot - identify requires a userId");
    return { ok: false, reason: "missing_user_id" };
  }

  const body: Record<string, any> = {
    anonymous_id: payload.anonymousId,
    user_id: payload.userId,
    traits: payload.traits ?? {},
    timestamp: new Date().toISOString(),
  };

  // Stamp consent on the identify payload too (the consumer mirrors the same
  // upsert + history append for consent fields arriving on /identify).
  Object.assign(body, consentStampFields(consentSnapshot ?? null));

  if (payload.options?.identityVerification?.token) {
    body.identity_verification = {
      token: payload.options.identityVerification.token,
    };
  }

  const endpoint = identifyUrlFromConfig(config);
  if (!endpoint) {
    return { ok: false, reason: "no_endpoint" };
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-logspot-pk": config.publicKey,
      },
      mode: "cors",
      keepalive: true,
      body: JSON.stringify(body),
    });

    if (response.ok) {
      return { ok: true, status: response.status };
    }

    let reason: string | undefined;
    try {
      const errorBody = await response.json();
      reason =
        typeof errorBody?.message === "string" ? errorBody.message : undefined;
    } catch {
      // non-JSON error body; leave reason undefined
    }
    console.error("Logspot - identify failed", response.status, reason);
    return { ok: false, status: response.status, reason };
  } catch (err) {
    console.error("Logspot - could not identify user");
    return { ok: false, reason: "network_error" };
  }
};

/**
 * Associate the current user/anonymous visitor with a group (Segment `group()`).
 * Sent with the `x-logspot-pk` header like the other public-API calls. The
 * platform requires a `user_id` or `anonymous_id`; the SDK always supplies its
 * managed `anonymous_id`, and `user_id` when the visitor is identified.
 */
export const groupUser = async (
  config: SdkConfig,
  payload: {
    anonymousId: string | null;
    userId?: string | null;
    groupId: string;
    type?: string;
    traits?: Record<string, any>;
    options?: IdentifyOptions;
  }
): Promise<IdentifyResult> => {
  if (!payload.groupId) {
    console.error("Logspot - group requires a groupId");
    return { ok: false, reason: "missing_group_id" };
  }
  if (!payload.userId && !payload.anonymousId) {
    console.error("Logspot - group requires a userId or anonymousId");
    return { ok: false, reason: "missing_subject" };
  }

  const body: Record<string, any> = {
    group_id: payload.groupId,
    type: payload.type || "company",
    anonymous_id: payload.anonymousId,
    timestamp: new Date().toISOString(),
  };
  if (payload.userId) body.user_id = payload.userId;
  if (payload.traits) body.traits = payload.traits;

  if (payload.options?.identityVerification?.token) {
    body.identity_verification = {
      token: payload.options.identityVerification.token,
    };
  }

  const endpoint = groupUrlFromConfig(config);
  if (!endpoint) {
    return { ok: false, reason: "no_endpoint" };
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-logspot-pk": config.publicKey,
      },
      mode: "cors",
      keepalive: true,
      body: JSON.stringify(body),
    });

    if (response.ok) {
      return { ok: true, status: response.status };
    }

    let reason: string | undefined;
    try {
      const errorBody = await response.json();
      reason =
        typeof errorBody?.message === "string" ? errorBody.message : undefined;
    } catch {
      // non-JSON error body; leave reason undefined
    }
    console.error("Logspot - group failed", response.status, reason);
    return { ok: false, status: response.status, reason };
  } catch (err) {
    console.error("Logspot - could not associate group");
    return { ok: false, reason: "network_error" };
  }
};

export type ConsentResult = {
  ok: boolean;
  status?: number;
  reason?: string;
};

/**
 * POST the current consent state to the backend `/consent` endpoint.
 *
 * Body shape:
 *   { anonymous_id?, user_id?, analytics?, functional?, marketing?,
 *     doNotSellShare?, gpc?, gppDetected?, gppString?, source, sourceMetadata? }
 *
 * Sent with the `x-logspot-pk` header like the other public-API calls. Only
 * fields that are present in the snapshot are included so the server can tell
 * "not specified" apart from an explicit `false`.
 */
export const postConsent = async (
  config: SdkConfig,
  payload: {
    anonymousId?: string | null;
    userId?: string | null;
    snapshot: ConsentSnapshot;
    // Secure Mode: same token shape as identify(). Backend rule for unverified
    // user_id-keyed writes is "restrict, never expand": consent DENIALS and
    // privacy signals still apply to the identity without a token; GRANTS
    // require a valid token (otherwise they only attach to the anonymous
    // device, or are rejected). Pass the token to make grants stick.
    identityVerification?: { token: string };
  }
): Promise<ConsentResult> => {
  const { categories, signals, source, sourceMetadata } = payload.snapshot;

  const body: Record<string, any> = { source };

  if (payload.anonymousId) body.anonymous_id = payload.anonymousId;
  if (payload.userId) body.user_id = payload.userId;

  if (typeof categories.analytics === "boolean")
    body.analytics = categories.analytics;
  if (typeof categories.functional === "boolean")
    body.functional = categories.functional;
  if (typeof categories.marketing === "boolean")
    body.marketing = categories.marketing;

  if (typeof signals.doNotSellShare === "boolean")
    body.doNotSellShare = signals.doNotSellShare;
  if (typeof signals.gpc === "boolean") body.gpc = signals.gpc;
  if (typeof signals.gppDetected === "boolean")
    body.gppDetected = signals.gppDetected;
  if (typeof signals.gppString === "string") body.gppString = signals.gppString;

  if (sourceMetadata) body.sourceMetadata = sourceMetadata;

  if (payload.identityVerification?.token) {
    body.identity_verification = {
      token: payload.identityVerification.token,
    };
  }

  const endpoint = consentUrlFromConfig(config);
  if (!endpoint) {
    return { ok: false, reason: "no_endpoint" };
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-logspot-pk": config.publicKey,
      },
      mode: "cors",
      keepalive: true,
      body: JSON.stringify(body),
    });

    if (response.ok) {
      return { ok: true, status: response.status };
    }

    let reason: string | undefined;
    try {
      const errorBody = await response.json();
      reason =
        typeof errorBody?.message === "string" ? errorBody.message : undefined;
    } catch {
      // non-JSON error body; leave reason undefined
    }
    console.error("Logspot - consent push failed", response.status, reason);
    return { ok: false, status: response.status, reason };
  } catch (err) {
    console.error("Logspot - could not push consent");
    return { ok: false, reason: "network_error" };
  }
};
