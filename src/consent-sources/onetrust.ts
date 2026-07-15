import type { ConsentSnapshot, ConsentCategory } from "../consent";
import type { ConsentSource } from "./types";
import { listenToWindowEvents } from "./listen";

/**
 * OneTrust Cookie Consent adapter. Read-only.
 *
 * ## API surface (verified against OneTrust developer docs)
 *
 * - `window.OnetrustActiveGroups` — a comma-DELIMITED string of the currently
 *   active category group IDs, with LEADING and TRAILING commas, e.g.
 *   `,C0001,C0002,C0004,`. The bounding commas exist precisely so callers can
 *   test membership with `.indexOf(',C0002,')` without `C0002` false-matching
 *   `C0012`.
 *     Source: https://developer.onetrust.com/onetrust/docs/google-tag-manager
 *     Source: https://my.onetrust.com/s/article/UUID-66bcaaf1-c7ca-5f32-6760-c75a1337c226
 *
 * - `OneTrustGroupsUpdated` window event — dispatched both on initial script
 *   load AND whenever the user updates consent; `event.detail` is an array of
 *   active group IDs (e.g. `["C0001","C0002"]`). This is the cleanest change
 *   hook (no string parsing, no load-order dependency), so we subscribe to it.
 *     Source: https://developer.onetrust.com/onetrust/docs/javascript-events-guide
 *
 * - `window.OneTrust.OnConsentChanged(cb)` — a zero-argument change callback;
 *   used as a fallback subscription when the window event is unavailable. Inside
 *   it we re-read `OnetrustActiveGroups`.
 *     Source: https://developer.onetrust.com/onetrust/docs/javascript-api
 *
 * - `OneTrust.IsAlertBoxClosed()`: true when the OptanonAlertBoxClosed cookie is set and consent is valid; that cookie is written on Accept All, Reject All, Close (banner), and Save Settings. Sources: https://developer.onetrust.com/onetrust/docs/javascript-api and https://my.onetrust.com/s/article/UUID-2dc719a8-4be5-8d16-1dc8-c7b4147b88e0
 *
 * ## Category mapping (OneTrust default group IDs -> Logspot categories)
 *
 *   C0001 Strictly Necessary  -> (no Logspot category; always-on, not mapped)
 *   C0002 Performance         -> analytics    // OneTrust's own GCM example maps C0002 -> analytics_storage
 *   C0003 Functional          -> functional
 *   C0004 Targeting           -> marketing    // OneTrust maps C0004 -> ad_storage/ad_* in its GCM example
 *   C0005 Social Media        -> marketing    // social media = cross-site advertising/profiling
 *     Source (defaults + GCM mapping precedent): https://developer.onetrust.com/onetrust/docs/javascript-api
 *
 * CAVEAT: C0001–C0005 are OneTrust's OUT-OF-THE-BOX defaults and are
 * tenant-CUSTOMIZABLE (group IDs and even category labels can be changed per
 * tenant). We map the standard defaults; tenants using custom group IDs would
 * need a configurable mapping (a documented V1 limitation). Unknown/custom group
 * IDs are simply ignored (they grant no Logspot category).
 *
 * We report a category as `true` when its mapped group is active. We do NOT emit
 * `false` for inactive groups: OneTrust's active-groups string lists only what
 * is *granted*, and after a consent decision a group's absence means denied —
 * but on first load (opt-in model) only C0001 is present and the rest are
 * "pending". To stay conservative and avoid asserting a denial the user has not
 * made, an absent mapped group leaves that category UNSET (falls through to the
 * org's consentBehavior server-side). Once at least one non-necessary group is
 * active we treat absent mapped groups as explicit denials, since that indicates
 * the banner has been resolved. When only necessary groups are active, `IsAlertBoxClosed()` (with the OptanonAlertBoxClosed cookie as fallback when the API object is absent) disambiguates:
 * true means the banner was resolved (Reject All / dismissed), so we emit an all-false denial snapshot; false or absent keeps the null pre-decision fallthrough.
 */

const SOURCE_NAME = "onetrust";
const PRIORITY = 60;

/** Default OneTrust group ID -> Logspot category. C0001 (necessary) is unmapped. */
const GROUP_TO_CATEGORY: Record<string, ConsentCategory> = {
  C0002: "analytics",
  C0003: "functional",
  C0004: "marketing",
  C0005: "marketing",
};

type OneTrustGlobal = {
  OnConsentChanged?: (cb: () => void) => void;
  IsAlertBoxClosed?: () => boolean;
};

const getActiveGroupsString = (): string | null => {
  try {
    const value = (window as Window & { OnetrustActiveGroups?: unknown })
      .OnetrustActiveGroups;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
};

const getOneTrust = (): OneTrustGlobal | null => {
  try {
    const ot = (window as Window & { OneTrust?: unknown }).OneTrust;
    return ot && typeof ot === "object" ? (ot as OneTrustGlobal) : null;
  } catch {
    return null;
  }
};

const isAlertBoxClosed = (): boolean => {
  try {
    const ot = getOneTrust();
    if (ot && typeof ot.IsAlertBoxClosed === "function") {
      return ot.IsAlertBoxClosed() === true;
    }
  } catch {
    return false;
  }
  try {
    // API object absent: the OptanonAlertBoxClosed cookie carries the same signal.
    return document.cookie.indexOf("OptanonAlertBoxClosed=") !== -1;
  } catch {
    return false;
  }
};

/** Parse the comma-bounded active-groups string into a Set of group IDs. */
const parseActiveGroups = (raw: string): Set<string> => {
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
  );
};

const buildSnapshot = (raw: string): ConsentSnapshot | null => {
  const active = parseActiveGroups(raw);

  // "Banner resolved" heuristic: any non-necessary group active means the user
  // has made (or implied) a decision, so absent mapped groups read as denied.
  // Until then, absent groups stay unset (pending) rather than forced-denied.
  let anyNonNecessaryActive = false;
  let anyNonNecessaryActiveRaw = false;
  active.forEach((id) => {
    if (id !== "C0001") {
      anyNonNecessaryActiveRaw = true;
      if (GROUP_TO_CATEGORY[id]) anyNonNecessaryActive = true;
    }
  });

  const categories: Partial<Record<ConsentCategory, boolean>> = {};

  for (const [groupId, category] of Object.entries(GROUP_TO_CATEGORY)) {
    if (active.has(groupId)) {
      categories[category] = true;
    } else if (anyNonNecessaryActive && categories[category] !== true) {
      // Resolved banner + this group inactive => deny, unless another group
      // mapping to the same category already granted it (C0004/C0005 share
      // marketing — grant wins over deny).
      categories[category] = false;
    }
  }

  // No mapped groups active: pre-decision, or Reject All. A closed alert box
  // is the documented discriminator between the two (see header sources).
  if (Object.keys(categories).length === 0) {
    if (!isAlertBoxClosed()) return null;
    // Active non-necessary groups we can't map (custom group ids) = the user
    // GRANTED something; do not fabricate an all-false denial. Stay silent.
    if (anyNonNecessaryActiveRaw) return null;
    return {
      categories: { analytics: false, functional: false, marketing: false },
      signals: {},
      source: SOURCE_NAME,
      updatedAt: new Date().toISOString(),
      sourceMetadata: {
        activeGroups: Array.from(active),
        alertBoxClosed: true,
      },
    };
  }

  return {
    categories,
    signals: {},
    source: SOURCE_NAME,
    updatedAt: new Date().toISOString(),
    sourceMetadata: { activeGroups: Array.from(active) },
  };
};

/**
 * Construct the OneTrust source. Always returns a source; `read()` yields `null`
 * until `OnetrustActiveGroups` is present, so the registry registers it safely
 * even before the OneTrust script loads.
 */
export const createOneTrustSource = (): ConsentSource => {
  return {
    name: SOURCE_NAME,
    priority: PRIORITY,
    read(): ConsentSnapshot | null {
      try {
        const raw = getActiveGroupsString();
        if (raw === null) return null;
        return buildSnapshot(raw);
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

      // Primary: the OneTrustGroupsUpdated window event (fires on load + change).
      const off = listenToWindowEvents(["OneTrustGroupsUpdated"], notify);

      // Fallback: OneTrust.OnConsentChanged(cb), zero-arg; no documented
      // removal API, so the handler is just a no-op-safe closure.
      try {
        const ot = getOneTrust();
        if (ot && typeof ot.OnConsentChanged === "function") {
          ot.OnConsentChanged(notify);
        }
      } catch {
        // ignore
      }

      return off;
    },
  };
};
