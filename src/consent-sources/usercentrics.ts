import type { ConsentSnapshot, ConsentCategory } from "../consent";
import type { ConsentSource } from "./types";
import { listenToWindowEvents } from "./listen";

/**
 * Usercentrics adapter. Read-only.
 *
 * ## API surface (verified against Usercentrics docs)
 *
 * Usercentrics has TWO browser API generations and we support both:
 *
 * - V2 (hosted "UC_UI" CMP): dispatches the `ucEvent` window event. Its
 *   `e.detail.event === 'consent_status'` payload carries a per-category rollup
 *   object `e.detail.ucCategory`, where each category slug maps to
 *   `true` (all services consented) / `false` (all denied) / `null` (mixed).
 *   Init is signalled by `UC_UI_INITIALIZED`.
 *     Source: https://usercentrics.com/docs/web/features/v2/events_v2/events_v2/
 *     Source: https://usercentrics.com/docs/web/features/events/consent-events/
 *
 * - V3 (latest "Web CMP", `window.__ucCmp`): dispatches the `UC_CONSENT` window
 *   event whose `e.detail` is a `ConsentDetails` object. `detail.categories` is a
 *   record keyed by category id; each value has a `state` of
 *   `'ALL_DENIED' | 'SOME_ACCEPTED' | 'ALL_ACCEPTED'`. `window.__ucCmp` also
 *   exposes `getConsentDetails(): Promise<ConsentDetails>` (async — not used in
 *   the synchronous `read()`; we rely on the cached event detail instead).
 *     Source: https://usercentrics.com/docs/web/features/api/control-functionality/
 *     Source: https://usercentrics.com/docs/web/features/api/interfaces/
 *
 * Because `read()` must be synchronous and the hosted CMP has no synchronous
 * category getter, this adapter CACHES the most recent consent state seen on the
 * `ucEvent` / `UC_CONSENT` events (and on any pre-existing `window.__ucCmp`
 * detail captured at construction) and serves `read()` from that cache.
 *
 * ## Category mapping (Usercentrics slugs -> Logspot)
 *
 * Usercentrics categories are CONFIGURABLE per account, so there is no fixed
 * enum. The slugs guaranteed by Usercentrics' own examples are `essential`,
 * `functional`, `marketing` (+ `payment`, essential). We map by slug, matching
 * common conventions case-insensitively:
 *
 *   essential / necessary           -> (unmapped; always-on)
 *   functional / preferences        -> functional
 *   marketing / advertising         -> marketing
 *   analytics / statistics / performance -> analytics
 *
 * CAVEAT: because categories are account-configurable, a tenant may use a slug
 * we don't recognize (it is then ignored — granted nothing). This is a
 * documented V1 limitation; a configurable mapping would be a follow-up.
 *
 * A category rollup of `null` (V2 "mixed") or `'SOME_ACCEPTED'` (V3) is treated
 * conservatively as NOT granted (we only grant on a definitive all-accepted).
 */

const SOURCE_NAME = "usercentrics";
const PRIORITY = 60;

/** Normalized slug -> Logspot category. Keys are compared lower-cased. */
const SLUG_TO_CATEGORY: Record<string, ConsentCategory> = {
  functional: "functional",
  preferences: "functional",
  marketing: "marketing",
  advertising: "marketing",
  analytics: "analytics",
  statistics: "analytics",
  performance: "analytics",
};

const mapSlug = (slug: string): ConsentCategory | undefined => {
  return SLUG_TO_CATEGORY[slug.trim().toLowerCase()];
};

type CategoryGrants = Partial<Record<ConsentCategory, boolean>>;

/**
 * Fold a per-slug grant map into Logspot categories. When multiple slugs map to
 * the same Logspot category (e.g. analytics + statistics), a grant wins over a
 * denial (most-permissive within a single mapped category), but an explicit
 * denial still records `false` if no mapped slug granted it.
 */
const foldSlugGrants = (
  slugGrants: Array<{ slug: string; granted: boolean | null }>
): CategoryGrants => {
  const categories: CategoryGrants = {};
  for (const { slug, granted } of slugGrants) {
    const category = mapSlug(slug);
    if (!category) continue;
    // `null` (mixed) is conservatively a non-grant; treat as false unless
    // another slug grants the same category.
    const isGranted = granted === true;
    if (isGranted) {
      categories[category] = true;
    } else if (categories[category] !== true) {
      categories[category] = false;
    }
  }
  return categories;
};

/** Parse a V2 `ucEvent` detail (`ucCategory` rollup object). */
const parseV2Detail = (detail: unknown): CategoryGrants | null => {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as { event?: unknown; ucCategory?: unknown };
  if (d.event !== "consent_status") return null;
  const ucCategory = d.ucCategory;
  if (!ucCategory || typeof ucCategory !== "object") return null;

  const slugGrants = Object.entries(ucCategory as Record<string, unknown>).map(
    ([slug, value]) => ({
      slug,
      granted: value === true ? true : value === false ? false : null,
    })
  );
  const categories = foldSlugGrants(slugGrants);
  return Object.keys(categories).length > 0 ? categories : null;
};

/** Parse a V3 `UC_CONSENT` detail (`ConsentDetails.categories`). */
const parseV3Detail = (detail: unknown): CategoryGrants | null => {
  if (!detail || typeof detail !== "object") return null;
  const categoriesRecord = (detail as { categories?: unknown }).categories;
  if (!categoriesRecord || typeof categoriesRecord !== "object") return null;

  const slugGrants = Object.entries(
    categoriesRecord as Record<string, unknown>
  ).map(([slug, value]) => {
    const state =
      value && typeof value === "object"
        ? (value as { state?: unknown }).state
        : undefined;
    return {
      slug,
      granted:
        state === "ALL_ACCEPTED"
          ? true
          : state === "ALL_DENIED"
          ? false
          : null, // SOME_ACCEPTED / unknown => mixed
    };
  });
  const categories = foldSlugGrants(slugGrants);
  return Object.keys(categories).length > 0 ? categories : null;
};

const parseAnyDetail = (detail: unknown): CategoryGrants | null => {
  return parseV3Detail(detail) ?? parseV2Detail(detail);
};

/**
 * Construct the Usercentrics source. Caches the latest consent state from the
 * vendor's events; `read()` returns `null` until a consent event has been seen.
 */
export const createUsercentricsSource = (): ConsentSource => {
  let cached: CategoryGrants | null = null;

  return {
    name: SOURCE_NAME,
    priority: PRIORITY,
    read(): ConsentSnapshot | null {
      try {
        if (!cached || Object.keys(cached).length === 0) return null;
        return {
          categories: { ...cached },
          signals: {},
          source: SOURCE_NAME,
          updatedAt: new Date().toISOString(),
        };
      } catch {
        return null;
      }
    },
    subscribe(cb: () => void): () => void {
      const onDetail = (detail: unknown) => {
        const parsed = parseAnyDetail(detail);
        if (parsed) {
          cached = parsed;
          try {
            cb();
          } catch {
            // ignore subscriber errors
          }
        }
      };

      return listenToWindowEvents(["ucEvent", "UC_CONSENT"], (event) => {
        onDetail((event as CustomEvent).detail);
      });
    },
  };
};
