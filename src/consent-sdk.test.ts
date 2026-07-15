import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import { logspot } from "./index";
import { __resetInMemoryAnonymousIdForTests } from "./anonymous-id";
import { LOGSPOT_CONSENT_KEY, __resetInMemoryConsentForTests } from "./consent";

const PUBLIC_KEY = "pk_test_consent";

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

const bodyOf = (call: any[]) =>
  JSON.parse((call[1] as RequestInit).body as string);

const lastFetchBody = (fetchMock: Mock) => {
  const calls = fetchMock.mock.calls;
  return bodyOf(calls[calls.length - 1]);
};

const trackCalls = (fetchMock: Mock) =>
  fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/i"));

const consentCall = (fetchMock: Mock) =>
  fetchMock.mock.calls.find(([url]) => String(url).endsWith("/consent"));

const init = async (config: Record<string, unknown> = {}) => {
  await logspot.init({
    publicKey: PUBLIC_KEY,
    enableAutoPageviews: false,
    externalApiUrl: "https://api.example.com/i",
    ...config,
  });
};

const resetState = () => {
  resetCookies();
  window.localStorage.clear();
  __resetInMemoryAnonymousIdForTests();
  __resetInMemoryConsentForTests();
  // Clear any GPC/GPP globals left by individual tests.
  delete (navigator as any).globalPrivacyControl;
  delete (window as any).__gpp;
};

describe("@logspot/web - consent stamping (notRequired default)", () => {
  let fetchMock: ReturnType<typeof setupFetchMock>;

  beforeEach(async () => {
    resetState();
    fetchMock = setupFetchMock();
    await init();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stamps empty consent fields when no snapshot exists", async () => {
    await logspot.track({ event: "Signup" });

    const body = lastFetchBody(fetchMock);
    expect(body.privacy_categories).toBe("");
    expect(body.privacy_signals).toBe("");
    expect(body.consent_source).toBeNull();
  });

  it("does not queue under the default behavior (sends immediately)", async () => {
    await logspot.track({ event: "Immediate" });
    expect(trackCalls(fetchMock).length).toBe(1);
  });

  it("stamps canonical categories/signals after setConsent", async () => {
    await logspot.setConsent({
      analytics: true,
      functional: true,
      marketing: false,
      doNotSellShare: true,
    });

    fetchMock.mockClear();
    await logspot.track({ event: "Purchase" });

    const body = lastFetchBody(fetchMock);
    expect(body.privacy_categories).toBe("af");
    expect(body.privacy_signals).toBe("d");
    expect(body.consent_source).toBe("logspot_api");
  });

  it("stamps consent AFTER the eventMapper hook runs (stamps are not clobbered)", async () => {
    resetState();
    fetchMock = setupFetchMock();
    await init({
      eventMapper: (p: any) => ({
        ...p,
        // A hostile mapper trying to forge stamps must lose.
        privacy_categories: "afm",
        consent_source: "forged",
        metadata: { mapped: true },
      }),
    });

    await logspot.setConsent({ analytics: true });
    fetchMock.mockClear();
    await logspot.track({ event: "Mapped" });

    const body = lastFetchBody(fetchMock);
    expect(body.metadata.mapped).toBe(true); // mapper still ran
    expect(body.privacy_categories).toBe("a"); // SDK stamp wins
    expect(body.consent_source).toBe("logspot_api");
  });
});

describe("@logspot/web - setConsent()", () => {
  let fetchMock: ReturnType<typeof setupFetchMock>;

  beforeEach(async () => {
    resetState();
    fetchMock = setupFetchMock();
    await init();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("POSTs the consent state to /consent with the pk header and B3 body shape", async () => {
    await logspot.setConsent({
      analytics: true,
      functional: false,
      marketing: false,
      doNotSellShare: true,
    });

    const call = consentCall(fetchMock);
    expect(call).toBeDefined();
    const [url, opts] = call!;
    expect(url).toBe("https://api.example.com/consent");
    expect((opts as RequestInit).method).toBe("POST");
    expect((opts as any).headers["x-logspot-pk"]).toBe(PUBLIC_KEY);

    const body = bodyOf(call!);
    expect(body.source).toBe("logspot_api");
    expect(body.analytics).toBe(true);
    expect(body.functional).toBe(false);
    expect(body.marketing).toBe(false);
    expect(body.doNotSellShare).toBe(true);
    expect(typeof body.anonymous_id).toBe("string");
  });

  it("omits categories that were not specified (partial update)", async () => {
    await logspot.setConsent({ analytics: true });

    const body = bodyOf(consentCall(fetchMock)!);
    expect(body.analytics).toBe(true);
    expect("functional" in body).toBe(false);
    expect("marketing" in body).toBe(false);
  });

  it("merges partial updates across calls", async () => {
    await logspot.setConsent({ analytics: true, functional: true });
    await logspot.setConsent({ marketing: false });

    const snap = logspot.getConsent();
    expect(snap?.categories).toEqual({
      analytics: true,
      functional: true,
      marketing: false,
    });
  });

  it("derives the /consent URL from externalApiUrl when consentApiUrl is unset", async () => {
    await logspot.setConsent({ analytics: true });
    expect(consentCall(fetchMock)![0]).toBe("https://api.example.com/consent");
  });

  it("honors an explicit consentApiUrl override", async () => {
    resetState();
    fetchMock = setupFetchMock();
    await init({ consentApiUrl: "https://override.example.com/consent" });

    await logspot.setConsent({ analytics: true });
    expect(consentCall(fetchMock)![0]).toBe(
      "https://override.example.com/consent"
    );
  });

  it("includes user_id in the /consent body after identify()", async () => {
    await logspot.identify("user_77");
    fetchMock.mockClear();
    await logspot.setConsent({ analytics: true });

    const body = bodyOf(consentCall(fetchMock)!);
    expect(body.user_id).toBe("user_77");
  });

  it("reuses the identify() Secure-Mode token on subsequent consent pushes", async () => {
    await logspot.identify("user_77", undefined, {
      identityVerification: { token: "jwt-abc" },
    });
    fetchMock.mockClear();
    await logspot.setConsent({ analytics: true });

    const body = bodyOf(consentCall(fetchMock)!);
    expect(body.identity_verification).toEqual({ token: "jwt-abc" });
  });

  it("prefers an explicit identityVerification option over the remembered one", async () => {
    await logspot.identify("user_77", undefined, {
      identityVerification: { token: "jwt-old" },
    });
    fetchMock.mockClear();
    await logspot.setConsent(
      { analytics: true },
      { identityVerification: { token: "jwt-new" } }
    );

    const body = bodyOf(consentCall(fetchMock)!);
    expect(body.identity_verification).toEqual({ token: "jwt-new" });
  });

  it("omits identity_verification when no token is known", async () => {
    // The singleton remembers identify() state across tests in this file —
    // reset() clears identifiedUserId and the remembered token.
    logspot.reset();
    fetchMock.mockClear();
    await logspot.setConsent({ analytics: true });

    const body = bodyOf(consentCall(fetchMock)!);
    expect("identity_verification" in body).toBe(false);
  });
});

describe("@logspot/web - express-mode queue", () => {
  let fetchMock: ReturnType<typeof setupFetchMock>;

  beforeEach(() => {
    resetState();
    fetchMock = setupFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("queues events until the first snapshot, then flushes them stamped", async () => {
    await init({ consentBehavior: "express" });

    await logspot.track({ event: "Before1" });
    await logspot.track({ event: "Before2" });
    // Nothing sent yet — events are held in memory.
    expect(trackCalls(fetchMock).length).toBe(0);

    await logspot.setConsent({ analytics: true, functional: true });

    const sent = trackCalls(fetchMock);
    expect(sent.length).toBe(2);
    const names = sent.map((c) => bodyOf(c).name);
    expect(names).toEqual(["Before1", "Before2"]);
    // Flushed events carry the now-known stamp.
    for (const c of sent) {
      expect(bodyOf(c).privacy_categories).toBe("af");
      expect(bodyOf(c).consent_source).toBe("logspot_api");
    }
  });

  it("drops the queue when the first snapshot denies analytics", async () => {
    await init({ consentBehavior: "express" });

    await logspot.track({ event: "Dropped1" });
    await logspot.track({ event: "Dropped2" });
    expect(trackCalls(fetchMock).length).toBe(0);

    await logspot.setConsent({ analytics: false });

    // Queue dropped: no track events sent (only the /consent POST happened).
    expect(trackCalls(fetchMock).length).toBe(0);
    expect(consentCall(fetchMock)).toBeDefined();
  });

  it("sends immediately once a snapshot exists (no more queueing)", async () => {
    await init({ consentBehavior: "express" });
    await logspot.setConsent({ analytics: true });
    fetchMock.mockClear();

    await logspot.track({ event: "After" });
    expect(trackCalls(fetchMock).length).toBe(1);
    expect(lastFetchBody(fetchMock).privacy_categories).toBe("a");
  });

  it("flushes a pre-existing persisted snapshot without queueing", async () => {
    // Seed a persisted snapshot, then init express — snapshot already exists.
    await init();
    await logspot.setConsent({ analytics: true });

    // Re-init express with the persisted cookie present.
    __resetInMemoryConsentForTests();
    fetchMock = setupFetchMock();
    await init({ consentBehavior: "express" });

    await logspot.track({ event: "NotQueued" });
    expect(trackCalls(fetchMock).length).toBe(1);
  });
});

describe("@logspot/web - privacy signal detection on init", () => {
  let fetchMock: ReturnType<typeof setupFetchMock>;

  beforeEach(() => {
    resetState();
    fetchMock = setupFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (navigator as any).globalPrivacyControl;
    delete (window as any).__gpp;
  });

  it("merges GPC into an existing snapshot's signals on init", async () => {
    // Seed a snapshot first (default init), then re-init with GPC present.
    await init();
    await logspot.setConsent({ analytics: true });
    __resetInMemoryConsentForTests();

    (navigator as any).globalPrivacyControl = true;
    fetchMock = setupFetchMock();
    await init();

    fetchMock.mockClear();
    await logspot.track({ event: "WithGpc" });
    expect(lastFetchBody(fetchMock).privacy_signals).toContain("g");
  });

  it("detects GPP via window.__gpp ping and records detection in the snapshot", async () => {
    await init();
    await logspot.setConsent({ analytics: true });
    __resetInMemoryConsentForTests();

    (window as any).__gpp = (cmd: string, cb: (d: any, s: boolean) => void) => {
      if (cmd === "ping") {
        cb({ gppString: "DBABLA~BVQVAAAAAg.QA" }, true);
      }
    };
    fetchMock = setupFetchMock();
    await init();

    const snap = logspot.getConsent();
    expect(snap?.signals.gppDetected).toBe(true);
    expect(snap?.signals.gppString).toBe("DBABLA~BVQVAAAAAg.QA");

    fetchMock.mockClear();
    await logspot.track({ event: "WithGpp" });
    expect(lastFetchBody(fetchMock).privacy_signals).toContain("p");
  });

  it("does not create a snapshot from signals alone (express still queues)", async () => {
    (navigator as any).globalPrivacyControl = true;
    await init({ consentBehavior: "express" });

    await logspot.track({ event: "StillQueued" });
    // No consent source has spoken, so no snapshot — event stays queued.
    expect(trackCalls(fetchMock).length).toBe(0);
    expect(logspot.getConsent()).toBeNull();
  });
});

describe("@logspot/web - applyConsentSnapshot (plugin seam)", () => {
  let fetchMock: ReturnType<typeof setupFetchMock>;

  beforeEach(async () => {
    resetState();
    fetchMock = setupFetchMock();
    await init();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("accepts a snapshot from an external source and pushes to /consent", async () => {
    const accepted = await logspot.applyConsentSnapshot({
      categories: { analytics: true, functional: true },
      signals: { gpc: true },
      source: "concord",
      updatedAt: new Date().toISOString(),
      sourceMetadata: { region: "EU", version: 3 },
    });

    expect(accepted).toBe(true);
    expect(logspot.getConsent()?.source).toBe("concord");
    const body = bodyOf(consentCall(fetchMock)!);
    expect(body.source).toBe("concord");
    expect(body.sourceMetadata).toEqual({ region: "EU", version: 3 });
  });

  it("rejects a lower-priority source after an explicit setConsent (priority race)", async () => {
    await logspot.setConsent({ analytics: true });
    fetchMock.mockClear();

    const accepted = await logspot.applyConsentSnapshot({
      categories: { analytics: false },
      signals: {},
      source: "onetrust",
      updatedAt: new Date().toISOString(),
    });

    expect(accepted).toBe(false);
    expect(logspot.getConsent()?.source).toBe("logspot_api");
    expect(logspot.getConsent()?.categories.analytics).toBe(true);
    // Rejected snapshot must not POST.
    expect(consentCall(fetchMock)).toBeUndefined();
  });
});

describe("@logspot/web - reset clears consent", () => {
  let fetchMock: ReturnType<typeof setupFetchMock>;

  beforeEach(async () => {
    resetState();
    fetchMock = setupFetchMock();
    await init();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reset() clears the persisted snapshot", async () => {
    await logspot.setConsent({ analytics: true });
    expect(logspot.getConsent()).not.toBeNull();

    logspot.reset();

    expect(logspot.getConsent()).toBeNull();
    expect(document.cookie.includes(LOGSPOT_CONSENT_KEY)).toBe(false);
  });
});

describe("@logspot/web - consent egress gating (review regressions)", () => {
  let fetchMock: ReturnType<typeof setupFetchMock>;

  const denialSnapshot = {
    categories: { analytics: false, functional: false, marketing: false },
    signals: {},
    source: "onetrust" as const,
  };

  beforeEach(() => {
    resetState();
    fetchMock = setupFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("express mode: live track() stops after an explicit analytics denial", async () => {
    await init({ consentBehavior: "express" });
    await logspot.applyConsentSnapshot(denialSnapshot);
    fetchMock.mockClear();

    await logspot.track({ event: "After Denial" });
    expect(trackCalls(fetchMock)).toHaveLength(0);
  });

  it("implied mode: sends before a decision, stops after denial", async () => {
    await init({ consentBehavior: "implied" });
    fetchMock.mockClear();

    await logspot.track({ event: "Pre Decision" });
    expect(trackCalls(fetchMock)).toHaveLength(1);

    await logspot.applyConsentSnapshot(denialSnapshot);
    fetchMock.mockClear();
    await logspot.track({ event: "Post Denial" });
    expect(trackCalls(fetchMock)).toHaveLength(0);
  });

  it("notRequired mode: still sends after denial (server is the backstop)", async () => {
    await init();
    await logspot.applyConsentSnapshot(denialSnapshot);
    fetchMock.mockClear();

    await logspot.track({ event: "Server Enforced" });
    expect(trackCalls(fetchMock)).toHaveLength(1);
  });

  it("express flush: analytics-unknown snapshot keeps the queue, explicit grant flushes it", async () => {
    await init({ consentBehavior: "express" });
    fetchMock.mockClear();

    await logspot.track({ event: "Queued" });
    expect(trackCalls(fetchMock)).toHaveLength(0);

    await logspot.applyConsentSnapshot({
      categories: { marketing: true },
      signals: {},
      source: "gcm",
    });
    expect(trackCalls(fetchMock)).toHaveLength(0);

    await logspot.setConsent({ analytics: true });
    const flushed = trackCalls(fetchMock);
    expect(flushed).toHaveLength(1);
    expect(bodyOf(flushed[0]).name).toBe("Queued");
  });

  it("browser GPC survives a CMP snapshot with empty signals", async () => {
    (navigator as any).globalPrivacyControl = true;
    await init();

    await logspot.applyConsentSnapshot({
      categories: { analytics: true },
      signals: {},
      source: "onetrust",
    });

    expect(logspot.getConsent()?.signals.gpc).toBe(true);
    const consent = consentCall(fetchMock);
    expect(consent).toBeDefined();
    expect(bodyOf(consent!).gpc).toBe(true);
  });

  it("re-applying an identical snapshot does not re-POST /consent", async () => {
    await init();
    const snapshot = {
      categories: { analytics: true },
      signals: {},
      source: "onetrust" as const,
    };

    await logspot.applyConsentSnapshot(snapshot);
    await logspot.applyConsentSnapshot({ ...snapshot });

    const consentCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/consent")
    );
    expect(consentCalls).toHaveLength(1);
  });
});

describe("@logspot/web - express partial-snapshot gate (review regressions R2)", () => {
  let fetchMock: ReturnType<typeof setupFetchMock>;

  beforeEach(() => {
    resetState();
    fetchMock = setupFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("express: a partial snapshot (analytics unknown) does NOT open egress", async () => {
    await init({ consentBehavior: "express" });
    fetchMock.mockClear();

    // Do-Not-Sell-only decision: a snapshot exists but analytics is unknown.
    await logspot.setConsent({ doNotSellShare: true });
    await logspot.track({ event: "Should Queue" });
    expect(trackCalls(fetchMock)).toHaveLength(0);

    // An explicit analytics grant releases the queue and live traffic.
    await logspot.setConsent({ analytics: true });
    expect(trackCalls(fetchMock).length).toBeGreaterThanOrEqual(1);
  });

  it("express: an ads-only CMP snapshot (marketing set, analytics unknown) queues", async () => {
    await init({ consentBehavior: "express" });
    await logspot.applyConsentSnapshot({
      categories: { marketing: true },
      signals: {},
      source: "gcm",
    });
    fetchMock.mockClear();

    await logspot.track({ event: "Ads Only" });
    expect(trackCalls(fetchMock)).toHaveLength(0);
  });

  it("mid-flush denial (higher-priority source) stops the remaining queued sends", async () => {
    await init({ consentBehavior: "express" });
    fetchMock.mockClear();

    for (let i = 0; i < 5; i++) {
      await logspot.track({ event: `Q${i}` });
    }
    expect(trackCalls(fetchMock)).toHaveLength(0);

    // On the 2nd flushed event, a higher-priority OneTrust Reject-All lands.
    let sent = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/i")) {
        sent += 1;
        if (sent === 2) {
          await logspot.applyConsentSnapshot({
            categories: { analytics: false, functional: false, marketing: false },
            signals: {},
            source: "onetrust",
          });
        }
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    // A low-priority GCM grant triggers the flush.
    await logspot.applyConsentSnapshot({
      categories: { analytics: true },
      signals: {},
      source: "gcm",
    });

    expect(trackCalls(fetchMock).length).toBeLessThan(5);
  });
});
