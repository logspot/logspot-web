// Remote (server-delivered) per-project config cache.
//
// The backend piggybacks a per-project `config` object on the `POST /i` track
// response. We cache it in localStorage keyed by the public key so a returning
// visitor applies the latest settings on the next page load, before the first
// event of that load fires. Everything here is best-effort and NEVER throws:
// localStorage may be unavailable, full, or hold corrupt JSON — in every case
// we fail safe (return null → autocapture stays off).

import { safeLocalStorage } from "./safe-storage";

/**
 * Autocapture projection delivered by the server. Mirrors the backend's
 * `{ v, autocapture: { enabled, types, notFound, downloads } }` shape. Fields
 * are intentionally loose (optional) so an older/newer server can add or omit
 * keys without breaking parse; the SDK reads only what it understands.
 *
 * The SDK reads `types.{ outboundLinks, fileDownloads, formSubmissions,
 * mediaPlayback }` and `downloads.extensions`. `types.notFound` (and the
 * `notFound` block) are RESERVED/deferred and ignored for now — there is no 404
 * capture yet. SPA pageviews are core (History-API based, always on with
 * `enableAutoPageviews`) and are NOT an autocapture type, so no `spaPageviews`
 * key is read.
 */
export type RemoteAutocaptureConfig = {
  enabled?: boolean;
  types?: {
    outboundLinks?: boolean;
    fileDownloads?: boolean;
    formSubmissions?: boolean;
    /** Native `<video>`/`<audio>` engagement (metadata only). */
    mediaPlayback?: boolean;
    /** Reserved/deferred — ignored by the SDK (no 404 capture yet). */
    notFound?: boolean;
  };
  /** Reserved/deferred 404-capture config — ignored by the SDK for now. */
  notFound?: Record<string, unknown> | null;
  downloads?: {
    extensions?: string[];
  };
};

/** The full config envelope the server returns on the track response. */
export type RemoteConfig = {
  /** Schema version of the config document. */
  v?: number;
  autocapture?: RemoteAutocaptureConfig;
};

/** Cache envelope persisted to localStorage. */
type CachedRemoteConfig = {
  /** Cache-format version (bump to invalidate all stored entries on upgrade). */
  cv: number;
  /** Epoch millis the config was stored. */
  ts: number;
  config: RemoteConfig;
};

/** localStorage key prefix; the public key is appended for per-project caching. */
export const REMOTE_CONFIG_KEY_PREFIX = "lgspt_cfg_";

/** Current cache-envelope format version. Bump to discard older entries. */
export const REMOTE_CONFIG_CACHE_VERSION = 1;

/**
 * How long a cached config is considered fresh (ms). After this it is treated
 * as absent (returns null) — the next track response refreshes it. Kept short
 * so dashboard changes propagate quickly; freshness ultimately rides the
 * piggybacked response, not this TTL.
 */
export const REMOTE_CONFIG_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const keyFor = (publicKey: string): string =>
  `${REMOTE_CONFIG_KEY_PREFIX}${publicKey}`;

/** Narrow an unknown parsed value to a cache envelope, or null. */
const asCachedConfig = (value: unknown): CachedRemoteConfig | null => {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<CachedRemoteConfig>;
  if (typeof candidate.cv !== "number" || typeof candidate.ts !== "number") {
    return null;
  }
  if (typeof candidate.config !== "object" || candidate.config === null) {
    return null;
  }
  return candidate as CachedRemoteConfig;
};

/**
 * Read the cached config for a public key. Returns null when there is nothing
 * cached, when the cache format / TTL no longer matches, or when anything at
 * all goes wrong (corrupt JSON, unavailable storage). Never throws.
 */
export const readRemoteConfig = (publicKey: string): RemoteConfig | null => {
  if (!publicKey) return null;
  const ls = safeLocalStorage();
  if (!ls) return null;

  let raw: string | null;
  try {
    raw = ls.getItem(keyFor(publicKey));
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const cached = asCachedConfig(parsed);
  if (!cached) return null;
  if (cached.cv !== REMOTE_CONFIG_CACHE_VERSION) return null;
  if (Date.now() - cached.ts > REMOTE_CONFIG_TTL_MS) return null;

  return cached.config;
};

/**
 * Persist the config for a public key. Best-effort: silently no-ops when
 * storage is unavailable or the write fails. Never throws.
 */
export const writeRemoteConfig = (
  publicKey: string,
  config: RemoteConfig
): void => {
  if (!publicKey || typeof config !== "object" || config === null) return;
  const ls = safeLocalStorage();
  if (!ls) return;

  const envelope: CachedRemoteConfig = {
    cv: REMOTE_CONFIG_CACHE_VERSION,
    ts: Date.now(),
    config,
  };

  try {
    ls.setItem(keyFor(publicKey), JSON.stringify(envelope));
  } catch {
    // Quota exceeded / serialization failure / unavailable — ignore.
  }
};

/** Remove the cached config for a public key. Never throws. */
export const clearRemoteConfig = (publicKey: string): void => {
  if (!publicKey) return;
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.removeItem(keyFor(publicKey));
  } catch {
    // ignore
  }
};
