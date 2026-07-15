import {
  eraseCookie,
  getCookie,
  ONE_YEAR_IN_SECONDS,
  setCookie,
} from "./cookie";
import { safeLocalStorage } from "./safe-storage";

/**
 * Consent store for the Logspot SDK.
 *
 * Holds the current consent snapshot ({categories, signals, source, updatedAt})
 * and persists it through the same layered fallback chain used by
 * `anonymous-id.ts`: cookie (`lgspt_consent`) -> localStorage -> in-memory.
 *
 * The store is *source-priority aware*: an external consent source (CMP plugin,
 * GCM reader, explicit Logspot API) writes a snapshot via `applySnapshot`, which
 * keeps the highest-priority snapshot authoritative. This lets a later plugins
 * agent register additional sources without re-architecting the store.
 */

export const LOGSPOT_CONSENT_KEY = "lgspt_consent";

// ---------------------------------------------------------------------------
// Canonical encodings (mirror packages/platform-types/src/consent.ts)
// ---------------------------------------------------------------------------

export type ConsentCategory = "analytics" | "functional" | "marketing";

/** Category -> single-letter code. */
export const CATEGORY_TO_LETTER: Record<ConsentCategory, string> = {
  analytics: "a",
  functional: "f",
  marketing: "m",
};

/** Canonical category order: a < f < m. */
export const CATEGORY_ORDER: ConsentCategory[] = [
  "analytics",
  "functional",
  "marketing",
];

const LETTER_TO_CATEGORY: Record<string, ConsentCategory> = {
  a: "analytics",
  f: "functional",
  m: "marketing",
};

export type PrivacySignals = {
  doNotSellShare?: boolean;
  gpc?: boolean;
  gppDetected?: boolean;
  /** Raw GPP string when present; detection + raw value only in V1. */
  gppString?: string;
};

/** Signal -> single-letter code. */
const SIGNAL_TO_LETTER: { key: keyof PrivacySignals; letter: string }[] = [
  { key: "doNotSellShare", letter: "d" },
  { key: "gpc", letter: "g" },
  { key: "gppDetected", letter: "p" },
];

// Canonical signal order: d < g < p.
const VALID_SIGNAL_LETTERS = new Set(["d", "g", "p"]);

/**
 * Encode a set of granted categories into a canonical string (`a` < `f` < `m`).
 * Categories whose value is not strictly `true` are omitted.
 */
export const encodeCategories = (
  categories: Partial<Record<ConsentCategory, boolean | undefined>>
): string => {
  let out = "";
  for (const category of CATEGORY_ORDER) {
    if (categories[category] === true) {
      out += CATEGORY_TO_LETTER[category];
    }
  }
  return out;
};

/**
 * Decode a canonical (or non-canonical) category string into a partial map.
 * Invalid letters are rejected (throw) so callers never silently accept e.g.
 * `x`. Repeated letters collapse to a single grant.
 */
export const decodeCategories = (
  encoded: string
): Partial<Record<ConsentCategory, boolean>> => {
  const out: Partial<Record<ConsentCategory, boolean>> = {};
  for (const ch of encoded) {
    const category = LETTER_TO_CATEGORY[ch];
    if (!category) {
      throw new Error(`Logspot - invalid privacy_categories letter: "${ch}"`);
    }
    out[category] = true;
  }
  return out;
};

/**
 * Encode privacy signals into a canonical string (`d` < `g` < `p`).
 * Only signals whose value is strictly `true` are included; `gppString` is a
 * raw value carried separately and never encoded into `privacy_signals`.
 */
export const encodeSignals = (signals: PrivacySignals): string => {
  let out = "";
  for (const { key, letter } of SIGNAL_TO_LETTER) {
    if (signals[key] === true) {
      out += letter;
    }
  }
  return out;
};

/** Decode a signals string into the boolean flags. Invalid letters are rejected. */
export const decodeSignals = (encoded: string): PrivacySignals => {
  const out: PrivacySignals = {};
  for (const ch of encoded) {
    if (!VALID_SIGNAL_LETTERS.has(ch)) {
      throw new Error(`Logspot - invalid privacy_signals letter: "${ch}"`);
    }
    if (ch === "d") out.doNotSellShare = true;
    if (ch === "g") out.gpc = true;
    if (ch === "p") out.gppDetected = true;
  }
  return out;
};

// ---------------------------------------------------------------------------
// Snapshot type + source-priority ladder
// ---------------------------------------------------------------------------

/**
 * Consent source identifiers, highest priority first. A higher-priority source
 * never has its snapshot replaced by a lower-priority one.
 * (logspot_api > concord > onetrust/usercentrics/cookiebot > gcm)
 */
export type ConsentSourceName =
  | "logspot_api"
  | "concord"
  | "onetrust"
  | "usercentrics"
  | "cookiebot"
  | "gcm";

const SOURCE_PRIORITY: Record<ConsentSourceName, number> = {
  logspot_api: 100,
  concord: 80,
  onetrust: 60,
  usercentrics: 60,
  cookiebot: 60,
  gcm: 40,
};

/** Resolve a source's priority; unknown sources rank below all known ones. */
export const consentSourcePriority = (source: string): number =>
  SOURCE_PRIORITY[source as ConsentSourceName] ?? 0;

/**
 * A persisted consent snapshot. `categories` is a partial map: an absent key
 * means "this source never spoke about that category" (falls through to the
 * org's consentBehavior server-side), distinct from an explicit `false` (denied).
 */
export type ConsentSnapshot = {
  categories: Partial<Record<ConsentCategory, boolean>>;
  signals: PrivacySignals;
  source: string;
  updatedAt: string;
  /** Optional vendor payload / consent version / region for `/consent`. */
  sourceMetadata?: Record<string, unknown>;
};

export type ConsentStorageOptions = {
  cookiesDisabled?: boolean;
  cookieDomain?: string | null;
  cookieExpirationInSeconds?: number;
};

// ---------------------------------------------------------------------------
// Layered persistence (mirrors anonymous-id.ts exactly)
// ---------------------------------------------------------------------------


const serialize = (snapshot: ConsentSnapshot): string => {
  try {
    return JSON.stringify(snapshot);
  } catch {
    return "";
  }
};

const deserialize = (raw: string | null): ConsentSnapshot | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.source !== "string"
    ) {
      return null;
    }
    return {
      categories:
        parsed.categories && typeof parsed.categories === "object"
          ? parsed.categories
          : {},
      signals:
        parsed.signals && typeof parsed.signals === "object"
          ? parsed.signals
          : {},
      source: parsed.source,
      updatedAt:
        typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : new Date().toISOString(),
      sourceMetadata:
        parsed.sourceMetadata && typeof parsed.sourceMetadata === "object"
          ? parsed.sourceMetadata
          : undefined,
    };
  } catch {
    return null;
  }
};

const tryReadCookie = (): ConsentSnapshot | null => {
  try {
    const raw = getCookie(LOGSPOT_CONSENT_KEY);
    return deserialize(raw ? decodeURIComponent(raw) : null);
  } catch {
    return null;
  }
};

const tryWriteCookie = (
  snapshot: ConsentSnapshot,
  opts: ConsentStorageOptions
): void => {
  try {
    setCookie({
      name: LOGSPOT_CONSENT_KEY,
      value: encodeURIComponent(serialize(snapshot)),
      expiresInSeconds: opts.cookieExpirationInSeconds ?? ONE_YEAR_IN_SECONDS,
      domain: opts.cookieDomain ?? null,
    });
  } catch {
    // ignore; fall through to localStorage / memory
  }
};

const tryReadLocalStorage = (): ConsentSnapshot | null => {
  const ls = safeLocalStorage();
  if (!ls) return null;
  try {
    return deserialize(ls.getItem(LOGSPOT_CONSENT_KEY));
  } catch {
    return null;
  }
};

const tryWriteLocalStorage = (snapshot: ConsentSnapshot): void => {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.setItem(LOGSPOT_CONSENT_KEY, serialize(snapshot));
  } catch {
    // ignore
  }
};

let inMemorySnapshot: ConsentSnapshot | null = null;

/**
 * Read the persisted snapshot: cookie -> localStorage -> in-memory.
 * Honors `cookiesDisabled` exactly like `readAnonymousId`.
 */
export const readConsentSnapshot = (
  opts: ConsentStorageOptions
): ConsentSnapshot | null => {
  if (!opts.cookiesDisabled) {
    const fromCookie = tryReadCookie();
    if (fromCookie) return fromCookie;
  }

  const fromLs = tryReadLocalStorage();
  if (fromLs) return fromLs;

  return inMemorySnapshot;
};

/**
 * Persist a snapshot through the storage chain. Cookie first (unless disabled),
 * then localStorage, then in-memory as the last-resort layer.
 */
export const writeConsentSnapshot = (
  snapshot: ConsentSnapshot,
  opts: ConsentStorageOptions
): void => {
  if (!opts.cookiesDisabled) {
    tryWriteCookie(snapshot, opts);
  }
  tryWriteLocalStorage(snapshot);
  inMemorySnapshot = snapshot;
};

/** Clear the consent snapshot from every storage layer. Used by reset(). */
export const clearConsentSnapshot = (opts: ConsentStorageOptions): void => {
  try {
    eraseCookie(LOGSPOT_CONSENT_KEY, opts.cookieDomain ?? null);
  } catch {
    // ignore
  }
  const ls = safeLocalStorage();
  if (ls) {
    try {
      ls.removeItem(LOGSPOT_CONSENT_KEY);
    } catch {
      // ignore
    }
  }
  inMemorySnapshot = null;
};

// ---------------------------------------------------------------------------
// ConsentStore — priority-aware authoritative snapshot holder
// ---------------------------------------------------------------------------

/**
 * Stateful wrapper around the persisted snapshot. The SDK keeps one instance.
 *
 * `applySnapshot(snapshot)` is the clean internal API external sources write
 * through: it enforces source priority (a lower-priority source never replaces
 * a higher-priority snapshot) and persists + returns whether it became
 * authoritative. The consent-source registry writes through this API.
 */
export class ConsentStore {
  private current: ConsentSnapshot | null;

  constructor(private readonly opts: ConsentStorageOptions) {
    this.current = readConsentSnapshot(opts);
  }

  /** The current authoritative snapshot, or null if no source has spoken. */
  get(): ConsentSnapshot | null {
    return this.current;
  }

  /** True once any source has produced a snapshot. */
  hasSnapshot(): boolean {
    return this.current !== null;
  }

  /**
   * Apply a snapshot from a consent source. Returns `true` if it became (or
   * remained) the authoritative snapshot and was persisted, `false` if it was
   * rejected because a strictly higher-priority source is already authoritative.
   *
   * Ties (same source priority, e.g. a fresh read from the same source) always
   * win so updates from the authoritative source are not dropped.
   */
  applySnapshot(snapshot: ConsentSnapshot): boolean {
    if (this.current) {
      const incoming = consentSourcePriority(snapshot.source);
      const existing = consentSourcePriority(this.current.source);
      if (incoming < existing) {
        return false;
      }
    }
    this.current = snapshot;
    writeConsentSnapshot(snapshot, this.opts);
    return true;
  }

  /**
   * Merge a partial update into the snapshot from a given source. Used by
   * `setConsent` (source `logspot_api`): unspecified categories/signals are
   * preserved from the existing snapshot. Subject to the same priority rule.
   */
  mergeSnapshot(
    partial: {
      categories?: Partial<Record<ConsentCategory, boolean>>;
      signals?: PrivacySignals;
      sourceMetadata?: Record<string, unknown>;
    },
    source: string
  ): boolean {
    const base = this.current;
    const merged: ConsentSnapshot = {
      categories: { ...(base?.categories ?? {}), ...(partial.categories ?? {}) },
      signals: { ...(base?.signals ?? {}), ...(partial.signals ?? {}) },
      source,
      updatedAt: new Date().toISOString(),
      sourceMetadata: partial.sourceMetadata ?? base?.sourceMetadata,
    };
    return this.applySnapshot(merged);
  }

  /** Clear all consent state (every storage layer). Used by reset(). */
  clear(): void {
    clearConsentSnapshot(this.opts);
    this.current = null;
  }
}

/** Test-only: reset the in-memory fallback layer. */
export const __resetInMemoryConsentForTests = (): void => {
  inMemorySnapshot = null;
};
