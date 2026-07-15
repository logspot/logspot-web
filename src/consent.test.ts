import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ConsentSnapshot,
  ConsentStore,
  LOGSPOT_CONSENT_KEY,
  __resetInMemoryConsentForTests,
  consentSourcePriority,
  decodeCategories,
  decodeSignals,
  encodeCategories,
  encodeSignals,
  readConsentSnapshot,
  writeConsentSnapshot,
} from "./consent";

const resetCookies = () => {
  const cookies = document.cookie ? document.cookie.split(";") : [];
  for (const c of cookies) {
    const eq = c.indexOf("=");
    const name = (eq > -1 ? c.substring(0, eq) : c).trim();
    document.cookie = `${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;`;
  }
};

const snapshot = (over: Partial<ConsentSnapshot> = {}): ConsentSnapshot => ({
  categories: { analytics: true, functional: true },
  signals: { gpc: true },
  source: "logspot_api",
  updatedAt: "2026-06-11T18:00:00.000Z",
  ...over,
});

describe("consent — canonical encoding", () => {
  it("encodes categories in canonical order a<f<m regardless of input order", () => {
    expect(encodeCategories({ marketing: true, analytics: true })).toBe("am");
    expect(
      encodeCategories({ functional: true, marketing: true, analytics: true })
    ).toBe("afm");
    expect(encodeCategories({ functional: true })).toBe("f");
    expect(encodeCategories({})).toBe("");
  });

  it("omits non-true categories (false and absent are both excluded)", () => {
    expect(
      encodeCategories({ analytics: true, functional: false, marketing: undefined })
    ).toBe("a");
  });

  it("decodes a canonical string into the category map", () => {
    expect(decodeCategories("afm")).toEqual({
      analytics: true,
      functional: true,
      marketing: true,
    });
    expect(decodeCategories("")).toEqual({});
  });

  it("rejects invalid category letters", () => {
    expect(() => decodeCategories("ax")).toThrow(/invalid privacy_categories/);
    expect(() => decodeCategories("z")).toThrow();
  });

  it("encodes signals in canonical order d<g<p", () => {
    expect(encodeSignals({ gpc: true, doNotSellShare: true })).toBe("dg");
    expect(
      encodeSignals({ gppDetected: true, doNotSellShare: true, gpc: true })
    ).toBe("dgp");
    expect(encodeSignals({})).toBe("");
  });

  it("never encodes gppString into the signals letters", () => {
    expect(encodeSignals({ gppDetected: true, gppString: "DBABLA~xxxx" })).toBe(
      "p"
    );
  });

  it("decodes signals and rejects invalid letters", () => {
    expect(decodeSignals("dgp")).toEqual({
      doNotSellShare: true,
      gpc: true,
      gppDetected: true,
    });
    expect(() => decodeSignals("dx")).toThrow(/invalid privacy_signals/);
  });
});

describe("consent — source priority", () => {
  it("ranks sources per the ladder logspot_api > concord > 3p CMP > gcm", () => {
    expect(consentSourcePriority("logspot_api")).toBeGreaterThan(
      consentSourcePriority("concord")
    );
    expect(consentSourcePriority("concord")).toBeGreaterThan(
      consentSourcePriority("onetrust")
    );
    expect(consentSourcePriority("onetrust")).toBe(
      consentSourcePriority("usercentrics")
    );
    expect(consentSourcePriority("cookiebot")).toBeGreaterThan(
      consentSourcePriority("gcm")
    );
    expect(consentSourcePriority("unknown_vendor")).toBe(0);
  });
});

describe("consent store — persistence + fallbacks (mirrors anonymous-id.ts)", () => {
  beforeEach(() => {
    resetCookies();
    window.localStorage.clear();
    __resetInMemoryConsentForTests();
  });

  afterEach(() => {
    resetCookies();
    window.localStorage.clear();
    __resetInMemoryConsentForTests();
  });

  it("persists to cookie and reads it back", () => {
    writeConsentSnapshot(snapshot(), { cookiesDisabled: false });
    expect(document.cookie.includes(`${LOGSPOT_CONSENT_KEY}=`)).toBe(true);

    const read = readConsentSnapshot({ cookiesDisabled: false });
    expect(read?.source).toBe("logspot_api");
    expect(read?.categories).toEqual({ analytics: true, functional: true });
    expect(read?.signals).toEqual({ gpc: true });
  });

  it("falls through to localStorage when cookiesDisabled is true", () => {
    writeConsentSnapshot(snapshot(), { cookiesDisabled: true });

    expect(document.cookie.includes(LOGSPOT_CONSENT_KEY)).toBe(false);
    expect(window.localStorage.getItem(LOGSPOT_CONSENT_KEY)).toBeTruthy();

    const read = readConsentSnapshot({ cookiesDisabled: true });
    expect(read?.source).toBe("logspot_api");
  });

  it("falls back to in-memory when cookie and localStorage are both unavailable", () => {
    // Write goes to all layers; clear the persistent ones to leave only memory.
    writeConsentSnapshot(snapshot({ source: "concord" }), {
      cookiesDisabled: false,
    });
    resetCookies();
    window.localStorage.clear();

    const read = readConsentSnapshot({ cookiesDisabled: false });
    expect(read?.source).toBe("concord");
  });

  it("returns null when nothing has ever been written", () => {
    expect(readConsentSnapshot({ cookiesDisabled: false })).toBeNull();
  });

  it("survives a corrupt persisted value (returns null rather than throwing)", () => {
    document.cookie = `${LOGSPOT_CONSENT_KEY}=${encodeURIComponent("not json")}; Path=/`;
    expect(readConsentSnapshot({ cookiesDisabled: false })).toBeNull();
  });
});

describe("ConsentStore — priority-aware applySnapshot", () => {
  beforeEach(() => {
    resetCookies();
    window.localStorage.clear();
    __resetInMemoryConsentForTests();
  });

  it("accepts the first snapshot from any source", () => {
    const store = new ConsentStore({ cookiesDisabled: false });
    expect(store.hasSnapshot()).toBe(false);
    expect(store.applySnapshot(snapshot({ source: "gcm" }))).toBe(true);
    expect(store.get()?.source).toBe("gcm");
  });

  it("rejects a lower-priority source overwriting a higher-priority snapshot", () => {
    const store = new ConsentStore({ cookiesDisabled: false });
    store.applySnapshot(snapshot({ source: "logspot_api" }));

    const accepted = store.applySnapshot(
      snapshot({ source: "onetrust", categories: { analytics: false } })
    );
    expect(accepted).toBe(false);
    expect(store.get()?.source).toBe("logspot_api");
    expect(store.get()?.categories).toEqual({
      analytics: true,
      functional: true,
    });
  });

  it("lets a higher-priority source override a lower-priority snapshot (out-of-order delivery)", () => {
    const store = new ConsentStore({ cookiesDisabled: false });
    // CMP arrives first...
    store.applySnapshot(snapshot({ source: "onetrust" }));
    // ...then an explicit API call lands and must win.
    const accepted = store.applySnapshot(
      snapshot({ source: "logspot_api", categories: { marketing: true } })
    );
    expect(accepted).toBe(true);
    expect(store.get()?.source).toBe("logspot_api");
    expect(store.get()?.categories).toEqual({ marketing: true });
  });

  it("allows same-priority updates from the authoritative source (ties win)", () => {
    const store = new ConsentStore({ cookiesDisabled: false });
    store.applySnapshot(snapshot({ source: "logspot_api" }));
    const accepted = store.applySnapshot(
      snapshot({ source: "logspot_api", categories: { analytics: false } })
    );
    expect(accepted).toBe(true);
    expect(store.get()?.categories).toEqual({ analytics: false });
  });

  it("mergeSnapshot preserves unspecified categories from the prior snapshot", () => {
    const store = new ConsentStore({ cookiesDisabled: false });
    store.applySnapshot(
      snapshot({
        source: "logspot_api",
        categories: { analytics: true, functional: true },
        signals: {},
      })
    );

    store.mergeSnapshot({ categories: { marketing: false } }, "logspot_api");

    expect(store.get()?.categories).toEqual({
      analytics: true,
      functional: true,
      marketing: false,
    });
  });

  it("clear() removes the snapshot from every layer", () => {
    const store = new ConsentStore({ cookiesDisabled: false });
    store.applySnapshot(snapshot());
    store.clear();
    expect(store.get()).toBeNull();
    expect(document.cookie.includes(LOGSPOT_CONSENT_KEY)).toBe(false);
    expect(window.localStorage.getItem(LOGSPOT_CONSENT_KEY)).toBeNull();
  });
});
