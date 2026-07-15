import type { ConsentSnapshot, ConsentCategory } from "../consent";
import type { ConsentSource } from "./types";

/**
 * Google Consent Mode v2 READER.
 *
 * Strictly read-only: this source reads the current Google Consent Mode state
 * that some *other* tool on the page (a CMP, gtag bootstrap, GTM) has set, and
 * maps it onto Logspot's categories. It NEVER calls `gtag('consent', ...)` or
 * mutates Google state in any way — Logspot is a consumer of consent, never a
 * writer into Google.
 *
 * ## Where the state is read from
 *
 * gtag's bootstrap is `function gtag(){dataLayer.push(arguments)}`, so every
 * `gtag('consent','default'|'update', {...})` pushes the function's *arguments*
 * object (array-like: `entry[0]='consent'`, `entry[1]='default'|'update'`,
 * `entry[2]={signal:'granted'|'denied', ...}`) onto `window.dataLayer`. We scan
 * `dataLayer` in order and fold every consent entry into a per-signal map; later
 * entries win, so an `update` issued after the user chooses supersedes the
 * initial `default` (Google docs: "effective state = update when present, else
 * default").
 *   Source: https://developers.google.com/tag-platform/security/guides/consent
 *
 * As a best-effort *fallback* (when no scannable dataLayer entries exist, e.g. a
 * CMP registered the default internally), we read the internal consent state at
 * `window.google_tag_data.ics`. That object is INTERNAL/UNDOCUMENTED (it does
 * not appear in any developers.google.com page) and may break across gtag.js
 * releases, so it is only consulted when the documented dataLayer scan yields
 * nothing.
 *   Source (non-authoritative, flagged): https://gunnargriese.com/posts/consent-mode-v2/
 *
 * ## Mapping
 *
 *   analytics_storage                              -> analytics
 *   functionality_storage + personalization_storage -> functional  (AND)
 *   ad_storage + ad_user_data + ad_personalization -> marketing     (AND)
 *
 * ### Why AND across the functional/marketing groups
 *
 * Multiple GCM signals map onto a single Logspot category. GCM signals
 * are independently grantable, so a group can be split (e.g. `ad_storage`
 * granted but `ad_personalization` denied). Logspot categories gate downstream
 * *use* — granting `marketing` authorizes advertising use of the data. We choose
 * the CONSERVATIVE / least-privilege reading: a Logspot category is granted only
 * when EVERY GCM signal that maps to it is `granted`. If any contributing signal
 * is denied, the category is denied. This guarantees we never over-permit
 * marketing/functional use relative to what the user told Google. Verified
 * against Google's GCM v2 semantics (each signal carries an independent
 * granted/denied value; there is no documented roll-up), so the AND choice is a
 * deliberate policy decision, not an inference about Google's own roll-up.
 *
 * A signal that is *absent entirely* (never set) is treated as "unknown" and
 * does not by itself deny the category — only an explicit `denied` denies. A
 * category is reported only when at least one of its contributing signals has an
 * explicit value; categories with no information stay absent from the snapshot
 * (so they fall through to the org's `consentBehavior` server-side, exactly like
 * any other source that "never spoke" about a category).
 */

const SOURCE_NAME = "gcm";
const PRIORITY = 40;

type GcmValue = "granted" | "denied";

type GcmSignal =
  | "analytics_storage"
  | "functionality_storage"
  | "personalization_storage"
  | "ad_storage"
  | "ad_user_data"
  | "ad_personalization";

/** The GCM signals each Logspot category is composed from (conservative AND). */
const CATEGORY_SIGNALS: Record<ConsentCategory, GcmSignal[]> = {
  analytics: ["analytics_storage"],
  functional: ["functionality_storage", "personalization_storage"],
  marketing: ["ad_storage", "ad_user_data", "ad_personalization"],
};

const ALL_SIGNALS: GcmSignal[] = [
  "analytics_storage",
  "functionality_storage",
  "personalization_storage",
  "ad_storage",
  "ad_user_data",
  "ad_personalization",
];

const isGcmValue = (value: unknown): value is GcmValue =>
  value === "granted" || value === "denied";

/**
 * Fold the `window.dataLayer` consent entries into a per-signal value map.
 * Scans in push order so later (`update`) entries override earlier (`default`)
 * ones on a per-signal basis. Region scoping is ignored in V1: every matching
 * `default`/`update` is applied in order, so the last writer for each signal
 * wins (a documented simplification — region-specific defaults exist but are not
 * resolved here). Returns `null` when no consent entries are present.
 */
const readFromDataLayer = (): Partial<Record<GcmSignal, GcmValue>> | null => {
  let dataLayer: unknown;
  try {
    dataLayer = (window as Window & { dataLayer?: unknown }).dataLayer;
  } catch {
    return null;
  }
  if (!Array.isArray(dataLayer)) {
    return null;
  }

  const signals: Partial<Record<GcmSignal, GcmValue>> = {};
  let sawConsentEntry = false;

  for (const entry of dataLayer) {
    // Entries are array-like `arguments` objects: [0]='consent',
    // [1]='default'|'update', [2]={...}. Guard defensively — dataLayer holds
    // unrelated GTM/gtag pushes too.
    if (!entry || typeof entry !== "object") continue;
    const arrayLike = entry as { length?: number; [index: number]: unknown };
    if (typeof arrayLike.length !== "number" || arrayLike.length < 3) continue;
    if (arrayLike[0] !== "consent") continue;
    const mode = arrayLike[1];
    if (mode !== "default" && mode !== "update") continue;

    const params = arrayLike[2];
    if (!params || typeof params !== "object") continue;

    sawConsentEntry = true;
    for (const signal of ALL_SIGNALS) {
      const value = (params as Record<string, unknown>)[signal];
      if (isGcmValue(value)) {
        signals[signal] = value;
      }
    }
  }

  return sawConsentEntry ? signals : null;
};

/**
 * Best-effort fallback: read the internal consent state at
 * `window.google_tag_data.ics`. INTERNAL/UNDOCUMENTED — only consulted when the
 * documented dataLayer scan yields nothing. The `ics.entries` map is keyed by
 * signal; each entry exposes `update`/`default` (update supersedes) and/or a
 * `getConsentState(signal)` returning `1` (granted) / `0` (denied). We read
 * conservatively and tolerate any shape mismatch.
 */
const readFromInternalState = (): Partial<
  Record<GcmSignal, GcmValue>
> | null => {
  let ics: unknown;
  try {
    ics = (
      window as Window & {
        google_tag_data?: { ics?: unknown };
      }
    ).google_tag_data?.ics;
  } catch {
    return null;
  }
  if (!ics || typeof ics !== "object") return null;

  const signals: Partial<Record<GcmSignal, GcmValue>> = {};
  let sawAny = false;

  const entries = (ics as { entries?: unknown }).entries;
  if (entries && typeof entries === "object") {
    for (const signal of ALL_SIGNALS) {
      const entry = (entries as Record<string, unknown>)[signal];
      if (!entry || typeof entry !== "object") continue;
      // `update` supersedes `default` in the internal structure.
      const record = entry as { update?: unknown; default?: unknown };
      const raw =
        record.update !== undefined ? record.update : record.default;
      if (raw === true) {
        signals[signal] = "granted";
        sawAny = true;
      } else if (raw === false) {
        signals[signal] = "denied";
        sawAny = true;
      } else if (isGcmValue(raw)) {
        signals[signal] = raw;
        sawAny = true;
      }
    }
  }

  return sawAny ? signals : null;
};

/**
 * Compute one Logspot category from its GCM signals (conservative AND):
 *  - `false` if ANY contributing signal is explicitly `denied`,
 *  - `true` if ALL contributing signals are explicitly `granted`,
 *  - `undefined` (category omitted) if no contributing signal has a value.
 */
const resolveCategory = (
  category: ConsentCategory,
  signals: Partial<Record<GcmSignal, GcmValue>>
): boolean | undefined => {
  const contributing = CATEGORY_SIGNALS[category];
  let sawAny = false;
  let allGranted = true;

  for (const signal of contributing) {
    const value = signals[signal];
    if (value === undefined) {
      // Unknown — does not deny on its own, but the category can only be
      // *granted* if every contributing signal is explicitly granted.
      allGranted = false;
      continue;
    }
    sawAny = true;
    if (value === "denied") {
      return false;
    }
  }

  // Nothing spoke, or a granted+absent mix: unknown (absent never denies on its
  // own, per the contract above). Only an explicit `denied` returns false.
  if (!sawAny || !allGranted) return undefined;
  return true;
};

const buildSnapshot = (
  signals: Partial<Record<GcmSignal, GcmValue>>
): ConsentSnapshot | null => {
  const categories: Partial<Record<ConsentCategory, boolean>> = {};
  let sawAny = false;

  (Object.keys(CATEGORY_SIGNALS) as ConsentCategory[]).forEach((category) => {
    const resolved = resolveCategory(category, signals);
    if (resolved !== undefined) {
      categories[category] = resolved;
      sawAny = true;
    }
  });

  if (!sawAny) return null;

  return {
    categories,
    signals: {},
    source: SOURCE_NAME,
    updatedAt: new Date().toISOString(),
    sourceMetadata: { gcm: signals },
  };
};

/** Read the current GCM state: documented dataLayer scan, then internal fallback. */
const readGcmState = (): Partial<Record<GcmSignal, GcmValue>> | null => {
  return readFromDataLayer() ?? readFromInternalState();
};

/**
 * Construct the Google Consent Mode reader source. Always returns a source; its
 * `read()` yields `null` until consent entries are observable (so the registry
 * keeps it registered and re-reads on subscribe callbacks safely even when GCM
 * is not yet present).
 */
export const createGcmReaderSource = (): ConsentSource => {
  return {
    name: SOURCE_NAME,
    priority: PRIORITY,
    read(): ConsentSnapshot | null {
      try {
        const signals = readGcmState();
        if (!signals) return null;
        return buildSnapshot(signals);
      } catch {
        return null;
      }
    },
    subscribe(cb: () => void): () => void {
      // GCM has no consent-change event of its own. CMPs that drive consent mode
      // push a fresh `gtag('consent','update',...)` onto `dataLayer` (and/or
      // dispatch their own events handled by their own adapter). We hook the
      // dataLayer's `push` so that any later consent entry triggers a re-read.
      // This is read-only: we only wrap `push` to *observe*, never to mutate
      // Google state, and we restore the original on unsubscribe.
      let dataLayer: unknown;
      try {
        const win = window as Window & { dataLayer?: unknown };
        if (!Array.isArray(win.dataLayer)) {
          win.dataLayer = win.dataLayer ?? [];
        }
        dataLayer = win.dataLayer;
      } catch {
        return () => {};
      }
      if (!Array.isArray(dataLayer)) {
        return () => {};
      }

      const arr = dataLayer as unknown[] & {
        push: (...items: unknown[]) => number;
      };
      // Keep the exact original reference so unsubscribe restores it verbatim
      // (don't store a `.bind()` copy — that would replace the native push with
      // a different function on teardown).
      const originalPush = arr.push;

      const wrapped = (...items: unknown[]): number => {
        const result = originalPush.apply(arr, items);
        // Notify on any consent entry; the registry re-reads and the store
        // ignores no-op/lower-priority results.
        for (const item of items) {
          const arrayLike = item as { length?: number; [i: number]: unknown };
          if (
            arrayLike &&
            typeof arrayLike === "object" &&
            arrayLike[0] === "consent"
          ) {
            try {
              cb();
            } catch {
              // never let a subscriber error escape into gtag's push path
            }
            break;
          }
        }
        return result;
      };

      try {
        arr.push = wrapped as typeof arr.push;
      } catch {
        return () => {};
      }

      return () => {
        try {
          if (arr.push === (wrapped as typeof arr.push)) {
            arr.push = originalPush as typeof arr.push;
          }
        } catch {
          // ignore
        }
      };
    },
  };
};
