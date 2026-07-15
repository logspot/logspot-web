import type { ConsentSnapshot, ConsentCategory } from "../consent";
import type { ConsentSource } from "./types";
import { listenToWindowEvents } from "./listen";

/**
 * Cookiebot adapter. Read-only.
 *
 * ## API surface (verified against the Cookiebot developer reference)
 *   Source: https://www.cookiebot.com/en/developer/
 *
 * - `window.Cookiebot.consent` — read-only booleans for Cookiebot's four fixed
 *   categories: `necessary`, `preferences`, `statistics`, `marketing`. These are
 *   a fixed enum (unlike Usercentrics' configurable categories).
 * - `window.Cookiebot.hasResponse` — `true` once the user has responded (accept
 *   or decline). Used to distinguish "no decision yet" (all booleans default
 *   false / necessary true) from "explicitly all-denied".
 * - `window.Cookiebot.consent.method` — `'implied' | 'explicit'` (or null).
 * - Events (all dispatched on `window`):
 *     `CookiebotOnConsentReady` — fires when consent is ready, whether freshly
 *        submitted OR loaded from an existing cookie (read-on-load + every
 *        change). This is the primary subscription.
 *     `CookiebotOnAccept` / `CookiebotOnDecline` — explicit user actions (also
 *        re-fire for returning consented users); subscribed as a backstop.
 *
 * ## Category mapping (Cookiebot -> Logspot)
 *
 *   necessary   -> (always-on; not mapped to a Logspot category)
 *   preferences -> functional   // "remember user choices (language, region...)"
 *   statistics  -> analytics    // "anonymous analytics / how visitors use the site"
 *   marketing   -> marketing    // "tracking for ads / cross-site profiling"
 *
 * We map each Cookiebot boolean directly. Because Cookiebot exposes explicit
 * booleans (not just a granted-list), we emit `true`/`false` faithfully — but
 * only once `hasResponse` is true. Before a response, `read()` returns `null`
 * so the snapshot falls through to the org's consentBehavior server-side rather
 * than asserting denials the user has not made.
 */

const SOURCE_NAME = "cookiebot";
const PRIORITY = 60;

type CookiebotConsent = {
  necessary?: boolean;
  preferences?: boolean;
  statistics?: boolean;
  marketing?: boolean;
  method?: string | null;
};

type CookiebotGlobal = {
  consent?: CookiebotConsent;
  hasResponse?: boolean;
  consented?: boolean;
  declined?: boolean;
};

/** Cookiebot category -> Logspot category (necessary is intentionally unmapped). */
const CONSENT_FIELD_TO_CATEGORY: Array<{
  field: keyof CookiebotConsent;
  category: ConsentCategory;
}> = [
  { field: "preferences", category: "functional" },
  { field: "statistics", category: "analytics" },
  { field: "marketing", category: "marketing" },
];

const getCookiebot = (): CookiebotGlobal | null => {
  try {
    const cb = (window as Window & { Cookiebot?: unknown }).Cookiebot;
    return cb && typeof cb === "object" ? (cb as CookiebotGlobal) : null;
  } catch {
    return null;
  }
};

const buildSnapshot = (cb: CookiebotGlobal): ConsentSnapshot | null => {
  const consent = cb.consent;
  if (!consent || typeof consent !== "object") {
    return null;
  }
  // Only assert categories once the user has actually responded. Until then the
  // booleans are pre-decision defaults; emit null so we fall through.
  if (cb.hasResponse !== true) {
    return null;
  }

  const categories: Partial<Record<ConsentCategory, boolean>> = {};
  for (const { field, category } of CONSENT_FIELD_TO_CATEGORY) {
    const value = consent[field];
    if (typeof value === "boolean") {
      categories[category] = value;
    }
  }

  if (Object.keys(categories).length === 0) {
    return null;
  }

  return {
    categories,
    signals: {},
    source: SOURCE_NAME,
    updatedAt: new Date().toISOString(),
    sourceMetadata: {
      method: typeof consent.method === "string" ? consent.method : undefined,
    },
  };
};

/**
 * Construct the Cookiebot source. Always returns a source; `read()` yields
 * `null` until `window.Cookiebot` exists and the user has responded.
 */
export const createCookiebotSource = (): ConsentSource => {
  return {
    name: SOURCE_NAME,
    priority: PRIORITY,
    read(): ConsentSnapshot | null {
      try {
        const cb = getCookiebot();
        if (!cb) return null;
        return buildSnapshot(cb);
      } catch {
        return null;
      }
    },
    subscribe(cb: () => void): () => void {
      const notify = () => {
        try {
          cb();
        } catch {
          // ignore subscriber errors
        }
      };

      return listenToWindowEvents(
        ["CookiebotOnConsentReady", "CookiebotOnAccept", "CookiebotOnDecline"],
        notify
      );
    },
  };
};
