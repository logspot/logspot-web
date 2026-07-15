import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import { logspot } from "../index";
import { __resetInMemoryAnonymousIdForTests } from "../anonymous-id";
import { __resetInMemoryConsentForTests } from "../consent";
import { ConsentStore } from "../consent";
import { ConsentSourceRegistry } from "./index";
import { createGcmReaderSource } from "./gcm-reader";
import { createOneTrustSource } from "./onetrust";

const PUBLIC_KEY = "pk_test_race";

const resetCookies = () => {
  const cookies = document.cookie ? document.cookie.split(";") : [];
  for (const c of cookies) {
    const eq = c.indexOf("=");
    const name = (eq > -1 ? c.substring(0, eq) : c).trim();
    document.cookie = `${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;`;
  }
};

const setupFetchMock = () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const consentCall = (fetchMock: Mock) =>
  fetchMock.mock.calls.find(([url]) => String(url).endsWith("/consent"));

const cleanVendorGlobals = () => {
  delete (window as any).dataLayer;
  delete (window as any).google_tag_data;
  delete (window as any).OnetrustActiveGroups;
  delete (window as any).OneTrust;
  delete (window as any).Cookiebot;
  delete (window as any).concord;
};

const resetState = () => {
  resetCookies();
  window.localStorage.clear();
  __resetInMemoryAnonymousIdForTests();
  __resetInMemoryConsentForTests();
  cleanVendorGlobals();
  delete (navigator as any).globalPrivacyControl;
  delete (window as any).__gpp;
};

const init = async (config: Record<string, unknown> = {}) => {
  await logspot.init({
    publicKey: PUBLIC_KEY,
    enableAutoPageviews: false,
    externalApiUrl: "https://api.example.com/i",
    ...config,
  });
};

// ===========================================================================
// Priority races at the STORE level (unit, no SDK singleton)
// ===========================================================================

describe("priority races — ConsentStore + sources", () => {
  beforeEach(resetState);
  afterEach(resetState);

  it("GCM reader must NOT overwrite a OneTrust snapshot (lower tier loses)", () => {
    const store = new ConsentStore({ cookiesDisabled: false });

    // OneTrust speaks first.
    (window as any).OnetrustActiveGroups = ",C0001,C0002,";
    const otSnap = createOneTrustSource().read();
    expect(otSnap).not.toBeNull();
    expect(store.applySnapshot(otSnap!)).toBe(true);
    expect(store.get()?.source).toBe("onetrust");

    // GCM (priority 40 < onetrust 60) tries to overwrite => rejected.
    (window as any).dataLayer = [
      ["consent", "update", { analytics_storage: "denied" }],
    ];
    const gcmSnap = createGcmReaderSource().read();
    expect(gcmSnap).not.toBeNull();
    expect(store.applySnapshot(gcmSnap!)).toBe(false);
    expect(store.get()?.source).toBe("onetrust");
    expect(store.get()?.categories.analytics).toBe(true);
  });

  it("a higher-tier OneTrust snapshot overrides an earlier GCM snapshot (out-of-order)", () => {
    const store = new ConsentStore({ cookiesDisabled: false });

    (window as any).dataLayer = [
      ["consent", "default", { analytics_storage: "granted" }],
    ];
    store.applySnapshot(createGcmReaderSource().read()!);
    expect(store.get()?.source).toBe("gcm");

    (window as any).OnetrustActiveGroups = ",C0001,C0002,C0003,";
    expect(store.applySnapshot(createOneTrustSource().read()!)).toBe(true);
    expect(store.get()?.source).toBe("onetrust");
    expect(store.get()?.categories.functional).toBe(true);
  });
});

// ===========================================================================
// Priority races through the SDK registry + applyConsentSnapshot
// ===========================================================================

describe("priority races — SDK registry integration", () => {
  let fetchMock: ReturnType<typeof setupFetchMock>;

  beforeEach(() => {
    resetState();
    fetchMock = setupFetchMock();
  });

  afterEach(async () => {
    // reset() re-arms configured sources, so strip them with a source-less
    // re-init first; the follow-up reset then leaves no live registry behind.
    await init();
    logspot.reset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetState();
  });

  it("CMP snapshot arriving AFTER explicit setConsent must NOT overwrite (logspot_api outranks)", async () => {
    // OneTrust configured as a source, but the user has already set explicit
    // consent via the API.
    (window as any).OnetrustActiveGroups = ",C0001,C0002,";
    await init({ consentSources: ["onetrust"] });

    await logspot.setConsent({ analytics: false, marketing: false });
    expect(logspot.getConsent()?.source).toBe("logspot_api");

    fetchMock.mockClear();

    // OneTrust now fires a change granting analytics — must be rejected.
    (window as any).OnetrustActiveGroups = ",C0001,C0002,C0003,C0004,";
    window.dispatchEvent(
      new CustomEvent("OneTrustGroupsUpdated", {
        detail: ["C0001", "C0002", "C0003", "C0004"],
      })
    );
    // Let the fire-and-forget apply settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(logspot.getConsent()?.source).toBe("logspot_api");
    expect(logspot.getConsent()?.categories.analytics).toBe(false);
    expect(logspot.getConsent()?.categories.marketing).toBe(false);
    // The rejected snapshot must not POST to /consent.
    expect(consentCall(fetchMock)).toBeUndefined();
  });

  it("registry applies a source snapshot on init and POSTs it to /consent", async () => {
    (window as any).OnetrustActiveGroups = ",C0001,C0002,C0003,";
    await init({ consentSources: ["onetrust"] });

    // Initial read applied through the store + pushed.
    await Promise.resolve();
    await Promise.resolve();

    expect(logspot.getConsent()?.source).toBe("onetrust");
    expect(logspot.getConsent()?.categories.analytics).toBe(true);

    const call = consentCall(fetchMock);
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.source).toBe("onetrust");
  });

  it("sources registered but vendor globals absent => no snapshot, no crash, no POST", async () => {
    // No OnetrustActiveGroups / Cookiebot set.
    await init({ consentSources: ["onetrust", "cookiebot", "gcm"] });
    await Promise.resolve();

    expect(logspot.getConsent()).toBeNull();
    expect(consentCall(fetchMock)).toBeUndefined();

    // A later vendor appearance + event is still picked up (registry kept
    // subscribing safely).
    (window as any).Cookiebot = {
      hasResponse: true,
      consent: { necessary: true, statistics: true, marketing: false },
    };
    window.dispatchEvent(new CustomEvent("CookiebotOnConsentReady"));
    await Promise.resolve();
    await Promise.resolve();

    expect(logspot.getConsent()?.source).toBe("cookiebot");
    expect(logspot.getConsent()?.categories.analytics).toBe(true);
  });

  it("same-tier latest-write-wins: a OneTrust change updates the snapshot", async () => {
    (window as any).OnetrustActiveGroups = ",C0001,C0002,";
    await init({ consentSources: ["onetrust"] });
    await Promise.resolve();
    await Promise.resolve();
    expect(logspot.getConsent()?.categories.analytics).toBe(true);

    // User revokes analytics, grants marketing — same source, latest wins.
    (window as any).OnetrustActiveGroups = ",C0001,C0004,";
    window.dispatchEvent(
      new CustomEvent("OneTrustGroupsUpdated", {
        detail: ["C0001", "C0004"],
      })
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(logspot.getConsent()?.categories.analytics).toBe(false);
    expect(logspot.getConsent()?.categories.marketing).toBe(true);
  });

  it("reset() re-arms configured sources; without sources it fully detaches", async () => {
    (window as any).OnetrustActiveGroups = ",C0001,C0002,";
    await init({ consentSources: ["onetrust"] });
    await Promise.resolve();
    expect(logspot.getConsent()?.source).toBe("onetrust");

    // Logout semantics: reset() clears the store but re-arms the configured
    // sources, so the CMP state immediately re-populates.
    logspot.reset();
    expect(logspot.getConsent()?.source).toBe("onetrust");
    expect(logspot.getConsent()?.categories.analytics).toBe(true);

    // Re-init WITHOUT sources, then reset again: nothing re-arms, so every
    // registry is detached and later vendor events must be ignored.
    fetchMock = setupFetchMock();
    await init();
    logspot.reset();
    expect(logspot.getConsent()).toBeNull();
    fetchMock.mockClear();

    (window as any).OnetrustActiveGroups = ",C0001,C0002,C0003,";
    window.dispatchEvent(
      new CustomEvent("OneTrustGroupsUpdated", {
        detail: ["C0001", "C0002", "C0003"],
      })
    );
    await Promise.resolve();
    await Promise.resolve();

    // No live registry => no snapshot, no POST.
    expect(logspot.getConsent()).toBeNull();
    expect(consentCall(fetchMock)).toBeUndefined();
  });
});
