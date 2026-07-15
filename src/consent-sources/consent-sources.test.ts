import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsentSnapshot } from "../consent";
import type { ConsentSource } from "./types";
import {
  ConsentSourceRegistry,
  instantiateConsentSources,
} from "./index";
import { createGcmReaderSource } from "./gcm-reader";
import { createOneTrustSource } from "./onetrust";
import { createCookiebotSource } from "./cookiebot";
import { createUsercentricsSource } from "./usercentrics";
import { createConcordSource } from "./concord";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cleanGlobals = () => {
  delete (window as any).dataLayer;
  delete (window as any).google_tag_data;
  delete (window as any).OnetrustActiveGroups;
  delete (window as any).OneTrust;
  delete (window as any).Cookiebot;
  delete (window as any).concord;
};

/** Dispatch a window CustomEvent with a `detail` payload. */
const dispatch = (name: string, detail?: unknown) => {
  window.dispatchEvent(new CustomEvent(name, { detail }));
};

beforeEach(cleanGlobals);
afterEach(cleanGlobals);

// ===========================================================================
// GCM reader — read-only, AND mapping, default/update supersede
// ===========================================================================

describe("gcm-reader", () => {
  it("returns null when no dataLayer / consent entries exist", () => {
    const source = createGcmReaderSource();
    expect(source.read()).toBeNull();
  });

  it("maps analytics_storage -> analytics", () => {
    (window as any).dataLayer = [
      ["consent", "default", { analytics_storage: "granted" }],
    ];
    const snap = createGcmReaderSource().read();
    expect(snap?.categories.analytics).toBe(true);
    // functional/marketing untouched (no contributing signals) -> absent
    expect("functional" in (snap?.categories ?? {})).toBe(false);
    expect("marketing" in (snap?.categories ?? {})).toBe(false);
  });

  it("functional requires BOTH functionality_storage AND personalization_storage (conservative AND)", () => {
    (window as any).dataLayer = [
      [
        "consent",
        "default",
        {
          functionality_storage: "granted",
          personalization_storage: "denied",
        },
      ],
    ];
    // One denied => functional denied.
    expect(createGcmReaderSource().read()?.categories.functional).toBe(false);

    (window as any).dataLayer = [
      [
        "consent",
        "default",
        {
          functionality_storage: "granted",
          personalization_storage: "granted",
        },
      ],
    ];
    expect(createGcmReaderSource().read()?.categories.functional).toBe(true);
  });

  it("marketing requires ad_storage AND ad_user_data AND ad_personalization (conservative AND)", () => {
    (window as any).dataLayer = [
      [
        "consent",
        "default",
        {
          ad_storage: "granted",
          ad_user_data: "granted",
          ad_personalization: "granted",
        },
      ],
    ];
    expect(createGcmReaderSource().read()?.categories.marketing).toBe(true);

    (window as any).dataLayer = [
      [
        "consent",
        "default",
        {
          ad_storage: "granted",
          ad_user_data: "granted",
          ad_personalization: "denied",
        },
      ],
    ];
    expect(createGcmReaderSource().read()?.categories.marketing).toBe(false);
  });

  it("a partially-specified marketing group with no denial stays unknown (not granted)", () => {
    // Only ad_storage granted; ad_user_data/ad_personalization never set.
    (window as any).dataLayer = [
      ["consent", "default", { ad_storage: "granted" }],
    ];
    // Granted+absent mix, none denied => unknown (absent never denies), NOT a
    // fabricated marketing denial.
    expect(
      createGcmReaderSource().read()?.categories.marketing
    ).toBeUndefined();
  });

  it("an explicit denial in a partially-specified group denies the category", () => {
    (window as any).dataLayer = [
      ["consent", "default", { ad_storage: "denied" }],
    ];
    expect(createGcmReaderSource().read()?.categories.marketing).toBe(false);
  });

  it("update supersedes default on a per-signal basis", () => {
    (window as any).dataLayer = [
      ["consent", "default", { analytics_storage: "denied" }],
      ["consent", "update", { analytics_storage: "granted" }],
    ];
    expect(createGcmReaderSource().read()?.categories.analytics).toBe(true);
  });

  it("tolerates arguments-object (array-like) entries, not just arrays", () => {
    function gtag(this: unknown) {
      // eslint-disable-next-line prefer-rest-params
      (window as any).dataLayer.push(arguments);
    }
    (window as any).dataLayer = [];
    (gtag as any)("consent", "default", { analytics_storage: "granted" });
    expect(createGcmReaderSource().read()?.categories.analytics).toBe(true);
  });

  it("falls back to google_tag_data.ics when dataLayer has no consent entries", () => {
    (window as any).dataLayer = [{ event: "gtm.js" }]; // unrelated push only
    (window as any).google_tag_data = {
      ics: {
        entries: {
          analytics_storage: { update: true },
          ad_storage: { update: false },
          ad_user_data: { update: false },
          ad_personalization: { update: false },
        },
      },
    };
    const snap = createGcmReaderSource().read();
    expect(snap?.categories.analytics).toBe(true);
    expect(snap?.categories.marketing).toBe(false);
  });

  it("subscribe fires the callback on a later consent push and restores push on unsubscribe", () => {
    (window as any).dataLayer = [];
    const source = createGcmReaderSource();
    const cb = vi.fn();
    const originalPush = (window as any).dataLayer.push;
    const off = source.subscribe(cb);
    expect((window as any).dataLayer.push).not.toBe(originalPush);

    (window as any).dataLayer.push([
      "consent",
      "update",
      { analytics_storage: "granted" },
    ]);
    expect(cb).toHaveBeenCalledTimes(1);

    // A non-consent push must NOT notify.
    (window as any).dataLayer.push({ event: "gtm.click" });
    expect(cb).toHaveBeenCalledTimes(1);

    off();
    expect((window as any).dataLayer.push).toBe(originalPush);
  });

  it("never calls gtag('consent', ...) — read/subscribe are observation only", () => {
    const gtagSpy = vi.fn();
    (window as any).gtag = gtagSpy;
    (window as any).dataLayer = [
      ["consent", "default", { analytics_storage: "granted" }],
    ];
    const source = createGcmReaderSource();
    source.read();
    const off = source.subscribe(() => {});
    (window as any).dataLayer.push([
      "consent",
      "update",
      { ad_storage: "granted" },
    ]);
    off();
    expect(gtagSpy).not.toHaveBeenCalled();
    delete (window as any).gtag;
  });
});

// ===========================================================================
// OneTrust
// ===========================================================================

describe("onetrust", () => {
  it("returns null when OnetrustActiveGroups is absent", () => {
    expect(createOneTrustSource().read()).toBeNull();
  });

  it("returns null pre-decision (only C0001 active, alert box not closed)", () => {
    (window as any).OnetrustActiveGroups = ",C0001,";
    // No OneTrust API object and no OptanonAlertBoxClosed cookie.
    expect(createOneTrustSource().read()).toBeNull();

    (window as any).OneTrust = { IsAlertBoxClosed: () => false };
    expect(createOneTrustSource().read()).toBeNull();
  });

  it("emits an all-false denial after Reject All (only C0001 active, alert box closed)", () => {
    (window as any).OnetrustActiveGroups = ",C0001,";
    (window as any).OneTrust = { IsAlertBoxClosed: () => true };
    const snap = createOneTrustSource().read();
    expect(snap?.categories).toEqual({
      analytics: false,
      functional: false,
      marketing: false,
    });
    expect(snap?.signals).toEqual({});
    expect(snap?.source).toBe("onetrust");
  });

  it("does NOT fabricate a denial when unmapped custom groups are active (Accept All)", () => {
    // Custom group ids (C0011/C0012) map to no Logspot category; the user
    // clicked Accept All, so we must not report an all-false denial.
    (window as any).OnetrustActiveGroups = ",C0001,C0011,C0012,";
    (window as any).OneTrust = { IsAlertBoxClosed: () => true };
    expect(createOneTrustSource().read()).toBeNull();
  });

  it("falls back to the OptanonAlertBoxClosed cookie when the API object is absent", () => {
    (window as any).OnetrustActiveGroups = ",C0001,";
    document.cookie = "OptanonAlertBoxClosed=2026-07-15T00:00:00.000Z";
    try {
      const snap = createOneTrustSource().read();
      expect(snap?.categories).toEqual({
        analytics: false,
        functional: false,
        marketing: false,
      });
    } finally {
      document.cookie =
        "OptanonAlertBoxClosed=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    }
  });

  it("maps active groups: C0002->analytics, C0003->functional, C0004->marketing", () => {
    (window as any).OnetrustActiveGroups = ",C0001,C0002,C0003,C0004,";
    const snap = createOneTrustSource().read();
    expect(snap?.categories).toEqual({
      analytics: true,
      functional: true,
      marketing: true,
    });
    expect(snap?.source).toBe("onetrust");
  });

  it("treats absent mapped groups as denied once the banner is resolved", () => {
    // C0002 active (decision made), C0003/C0004 inactive => denied.
    (window as any).OnetrustActiveGroups = ",C0001,C0002,";
    const snap = createOneTrustSource().read();
    expect(snap?.categories).toEqual({
      analytics: true,
      functional: false,
      marketing: false,
    });
  });

  it("C0005 (social) maps to marketing; grant wins over C0004 absence", () => {
    (window as any).OnetrustActiveGroups = ",C0001,C0005,";
    const snap = createOneTrustSource().read();
    expect(snap?.categories.marketing).toBe(true);
  });

  it("does not false-match C0012 against the C0001 check (comma-bounded parse)", () => {
    (window as any).OnetrustActiveGroups = ",C0012,C0002,";
    const snap = createOneTrustSource().read();
    // C0012 is unknown/ignored; C0002 grants analytics.
    expect(snap?.categories.analytics).toBe(true);
    expect((snap?.sourceMetadata as any).activeGroups).toContain("C0012");
  });

  it("subscribe fires on OneTrustGroupsUpdated and detaches on unsubscribe", () => {
    const source = createOneTrustSource();
    const cb = vi.fn();
    const off = source.subscribe(cb);
    dispatch("OneTrustGroupsUpdated", ["C0001", "C0002"]);
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    dispatch("OneTrustGroupsUpdated", ["C0001"]);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("subscribe also wires OneTrust.OnConsentChanged when present", () => {
    let registered: (() => void) | null = null;
    (window as any).OneTrust = {
      OnConsentChanged: (fn: () => void) => {
        registered = fn;
      },
    };
    const source = createOneTrustSource();
    const cb = vi.fn();
    source.subscribe(cb);
    expect(typeof registered).toBe("function");
    registered!();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// Cookiebot
// ===========================================================================

describe("cookiebot", () => {
  it("returns null when Cookiebot is absent", () => {
    expect(createCookiebotSource().read()).toBeNull();
  });

  it("returns null until the user has responded (hasResponse false)", () => {
    (window as any).Cookiebot = {
      hasResponse: false,
      consent: { necessary: true, preferences: false, statistics: false, marketing: false },
    };
    expect(createCookiebotSource().read()).toBeNull();
  });

  it("maps statistics->analytics, preferences->functional, marketing->marketing", () => {
    (window as any).Cookiebot = {
      hasResponse: true,
      consent: {
        necessary: true,
        preferences: true,
        statistics: true,
        marketing: false,
        method: "explicit",
      },
    };
    const snap = createCookiebotSource().read();
    expect(snap?.categories).toEqual({
      functional: true,
      analytics: true,
      marketing: false,
    });
    expect((snap?.sourceMetadata as any).method).toBe("explicit");
  });

  it("subscribe fires on CookiebotOnConsentReady and detaches on unsubscribe", () => {
    const source = createCookiebotSource();
    const cb = vi.fn();
    const off = source.subscribe(cb);
    dispatch("CookiebotOnConsentReady");
    dispatch("CookiebotOnAccept");
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    dispatch("CookiebotOnConsentReady");
    expect(cb).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// Usercentrics — V2 ucEvent + V3 UC_CONSENT
// ===========================================================================

describe("usercentrics", () => {
  it("returns null before any consent event has been observed", () => {
    expect(createUsercentricsSource().read()).toBeNull();
  });

  it("reads V2 ucEvent ucCategory rollup (essential/functional/marketing)", () => {
    const source = createUsercentricsSource();
    source.subscribe(() => {});
    dispatch("ucEvent", {
      event: "consent_status",
      ucCategory: { essential: true, functional: true, marketing: false },
    });
    const snap = source.read();
    expect(snap?.categories).toEqual({
      functional: true,
      marketing: false,
    });
    expect(snap?.source).toBe("usercentrics");
  });

  it("treats V2 mixed (null) category as not granted", () => {
    const source = createUsercentricsSource();
    source.subscribe(() => {});
    dispatch("ucEvent", {
      event: "consent_status",
      ucCategory: { marketing: null },
    });
    expect(source.read()?.categories.marketing).toBe(false);
  });

  it("reads V3 UC_CONSENT categories state (ALL_ACCEPTED / ALL_DENIED / SOME_ACCEPTED)", () => {
    const source = createUsercentricsSource();
    source.subscribe(() => {});
    dispatch("UC_CONSENT", {
      categories: {
        marketing: { state: "ALL_ACCEPTED" },
        functional: { state: "ALL_DENIED" },
        analytics: { state: "SOME_ACCEPTED" },
      },
    });
    const snap = source.read();
    expect(snap?.categories.marketing).toBe(true);
    expect(snap?.categories.functional).toBe(false);
    // SOME_ACCEPTED is conservatively non-grant.
    expect(snap?.categories.analytics).toBe(false);
  });

  it("fires the subscribe callback when a consent event arrives", () => {
    const source = createUsercentricsSource();
    const cb = vi.fn();
    const off = source.subscribe(cb);
    dispatch("ucEvent", {
      event: "consent_status",
      ucCategory: { functional: true },
    });
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    dispatch("ucEvent", {
      event: "consent_status",
      ucCategory: { functional: false },
    });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("ignores non-consent ucEvent payloads", () => {
    const source = createUsercentricsSource();
    const cb = vi.fn();
    source.subscribe(cb);
    dispatch("ucEvent", { event: "something_else" });
    expect(cb).not.toHaveBeenCalled();
    expect(source.read()).toBeNull();
  });
});

// ===========================================================================
// Concord — window.concord.consent.hasConsent(category)
// Contract per https://www.concord.tech/docs/manually-blocking-trackers-before-consent
// ===========================================================================

const installConcord = (granted: Record<string, boolean>) => {
  (window as any).concord = {
    consent: {
      hasConsent: (category: string) => granted[category] === true,
    },
  };
};

describe("concord", () => {
  it("returns null when no Concord global is present", () => {
    expect(createConcordSource().read()).toBeNull();
  });

  it("returns null when window.concord exists without the consent API", () => {
    (window as any).concord = { captureConsentEvent: () => {} };
    expect(createConcordSource().read()).toBeNull();
  });

  it("reads all three categories via hasConsent (identity mapping)", () => {
    installConcord({ analytics: true, functional: true, marketing: false });
    const snap = createConcordSource().read();
    expect(snap?.categories).toEqual({
      analytics: true,
      functional: true,
      marketing: false,
    });
    expect(snap?.source).toBe("concord");
    // Older Concord builds without the signal helpers → categories only.
    expect(snap?.signals).toEqual({});
  });

  it("emits doNotSellShare when DNS is active and marketing is not granted", () => {
    (window as any).concord = {
      consent: {
        hasConsent: (category: string) =>
          ({ analytics: true, functional: true, marketing: false })[
            category
          ] === true,
        hasDoNotSell: () => true,
        hasGPC: () => true,
        isDefaults: false,
      },
    };
    const snap = createConcordSource().read();
    expect(snap?.categories.marketing).toBe(false);
    expect(snap?.signals).toEqual({ doNotSellShare: true, gpc: true });
    expect(snap?.sourceMetadata).toEqual({ isDefaults: false });
  });

  it("marketing=true + DNS active: BOTH facts reported faithfully (override is resolved downstream)", () => {
    // This combination almost always means DNS/GPC
    // auto-declined marketing and the user manually flipped it back on —
    // the explicit grant overrides the do-not-sell logic. The adapter
    // reports both facts verbatim; Logspot's export evaluation resolves
    // the override (explicit marketing=true beats doNotSellShare).
    (window as any).concord = {
      consent: {
        hasConsent: (category: string) =>
          ({ analytics: true, functional: true, marketing: true })[
            category
          ] === true,
        hasDoNotSell: () => true,
        hasGPC: () => true,
        isDefaults: false,
      },
    };
    const snap = createConcordSource().read();
    expect(snap?.categories.marketing).toBe(true);
    expect(snap?.signals).toEqual({ doNotSellShare: true, gpc: true });
    expect(snap?.sourceMetadata).toEqual({ isDefaults: false });
  });

  it("omits signals that are not asserted (false helpers)", () => {
    (window as any).concord = {
      consent: {
        hasConsent: () => true,
        hasDoNotSell: () => false,
        hasGPC: () => false,
        isDefaults: true,
      },
    };
    const snap = createConcordSource().read();
    expect(snap?.signals).toEqual({});
    expect(snap?.sourceMetadata).toEqual({ isDefaults: true });
  });

  it("pre-decision reads mirror Concord's gating: not granted = denied", () => {
    installConcord({});
    const snap = createConcordSource().read();
    expect(snap?.categories).toEqual({
      analytics: false,
      functional: false,
      marketing: false,
    });
  });

  it("notifies on concord-ready / state-loaded / state-changed events", () => {
    installConcord({ analytics: true });
    const source = createConcordSource();
    const cb = vi.fn();
    const off = source.subscribe(cb);
    dispatch("concord-ready");
    dispatch("concord-consent-state-loaded");
    dispatch("concord-consent-state-changed");
    expect(cb).toHaveBeenCalledTimes(3);
    off();
    dispatch("concord-consent-state-changed");
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("suppresses reads while consent state is loading, resumes when loaded", () => {
    installConcord({ analytics: true });
    const source = createConcordSource();
    source.subscribe(vi.fn());
    dispatch("concord-consent-state-loading");
    expect(source.read()).toBeNull();
    dispatch("concord-consent-state-loaded");
    expect(source.read()?.categories.analytics).toBe(true);
  });

  it("disables reads after concord-unavailable", () => {
    installConcord({ analytics: true });
    const source = createConcordSource();
    source.subscribe(vi.fn());
    dispatch("concord-unavailable");
    expect(source.read()).toBeNull();
  });
});

// ===========================================================================
// Registry
// ===========================================================================

describe("instantiateConsentSources", () => {
  it("instantiates known sources by name and alias", () => {
    const sources = instantiateConsentSources([
      "onetrust",
      "gcm",
      "Cookiebot",
    ]);
    const names = sources.map((s) => s.name).sort();
    expect(names).toEqual(["cookiebot", "gcm", "onetrust"]);
  });

  it("ignores unknown source names without throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sources = instantiateConsentSources(["bogus", "onetrust"]);
    expect(sources.map((s) => s.name)).toEqual(["onetrust"]);
    warn.mockRestore();
  });

  it("dedupes repeated names", () => {
    const sources = instantiateConsentSources(["onetrust", "onetrust"]);
    expect(sources.length).toBe(1);
  });
});

describe("ConsentSourceRegistry", () => {
  it("applies the initial snapshot from a present source on start()", () => {
    (window as any).OnetrustActiveGroups = ",C0001,C0002,";
    const applied: ConsentSnapshot[] = [];
    const registry = new ConsentSourceRegistry(
      [createOneTrustSource()],
      async (snap) => {
        applied.push(snap);
        return true;
      }
    );
    registry.start();
    expect(applied.length).toBe(1);
    expect(applied[0].source).toBe("onetrust");
    expect(applied[0].categories.analytics).toBe(true);
  });

  it("does not crash and applies nothing when the vendor global is absent", () => {
    const applied: ConsentSnapshot[] = [];
    const registry = new ConsentSourceRegistry(
      [createOneTrustSource(), createCookiebotSource()],
      async (snap) => {
        applied.push(snap);
        return true;
      }
    );
    expect(() => registry.start()).not.toThrow();
    expect(applied.length).toBe(0);
    registry.stop();
  });

  it("re-applies when a source signals a change", () => {
    const applied: ConsentSnapshot[] = [];
    const registry = new ConsentSourceRegistry(
      [createCookiebotSource()],
      async (snap) => {
        applied.push(snap);
        return true;
      }
    );
    registry.start();
    expect(applied.length).toBe(0); // no Cookiebot yet

    // Vendor loads + user responds, then fires the change event.
    (window as any).Cookiebot = {
      hasResponse: true,
      consent: { necessary: true, statistics: true, marketing: false },
    };
    dispatch("CookiebotOnConsentReady");
    expect(applied.length).toBe(1);
    expect(applied[0].categories.analytics).toBe(true);
  });

  it("stop() detaches subscriptions (no further applies)", () => {
    const applied: ConsentSnapshot[] = [];
    const registry = new ConsentSourceRegistry(
      [createCookiebotSource()],
      async (snap) => {
        applied.push(snap);
        return true;
      }
    );
    registry.start();
    registry.stop();

    (window as any).Cookiebot = {
      hasResponse: true,
      consent: { necessary: true, statistics: true },
    };
    dispatch("CookiebotOnConsentReady");
    expect(applied.length).toBe(0);
  });

  it("a throwing source never breaks the registry", () => {
    const throwingSource: ConsentSource = {
      name: "boom",
      priority: 1,
      read: () => {
        throw new Error("read boom");
      },
      subscribe: () => {
        throw new Error("subscribe boom");
      },
    };
    const registry = new ConsentSourceRegistry(
      [throwingSource, createOneTrustSource()],
      async () => true
    );
    expect(() => registry.start()).not.toThrow();
    expect(() => registry.stop()).not.toThrow();
  });
});
