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
import {
  __resetInMemoryAnonymousIdForTests,
  LOGSPOT_ANONYMOUS_ID_KEY,
} from "./anonymous-id";
import { LOGSPOT_COOKIE_ID } from "./cookie";

const PUBLIC_KEY = "pk_test_123";

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

const lastFetchBody = (fetchMock: Mock) => {
  const calls = fetchMock.mock.calls;
  const last = calls[calls.length - 1];
  return JSON.parse((last[1] as RequestInit).body as string);
};

const init = async (config: Record<string, unknown> = {}) => {
  await logspot.init({
    publicKey: PUBLIC_KEY,
    enableAutoPageviews: false,
    externalApiUrl: "https://api.example.com/i",
    ...config,
  });
};

describe("@logspot/web - anonymous identity", () => {
  let fetchMock: ReturnType<typeof setupFetchMock>;

  beforeEach(async () => {
    resetCookies();
    window.localStorage.clear();
    __resetInMemoryAnonymousIdForTests();
    fetchMock = setupFetchMock();
    await init();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("generates an anonymousId on init and persists it across reads", () => {
    const aid = logspot.getAnonymousId();
    expect(aid).toBeTruthy();
    expect(aid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );

    const cookieValue = document.cookie.includes(`${LOGSPOT_ANONYMOUS_ID_KEY}=`);
    const lsValue = window.localStorage.getItem(LOGSPOT_ANONYMOUS_ID_KEY);
    expect(cookieValue || lsValue === aid).toBe(true);
  });

  it("includes anonymous_id in track payloads without anonymous user_id", async () => {
    const aid = logspot.getAnonymousId();

    await logspot.track({ event: "Signup" });

    expect(fetchMock).toHaveBeenCalled();
    const body = lastFetchBody(fetchMock);
    expect(body.name).toBe("Signup");
    expect(body.anonymous_id).toBe(aid);
    expect(body.user_id).toBeNull();
  });

  it("migrates the legacy anonymous cookie into anonymous_id", async () => {
    const legacyAnonymousId = "ub7b19327f718c8d08db93";
    resetCookies();
    window.localStorage.clear();
    __resetInMemoryAnonymousIdForTests();
    document.cookie = `${LOGSPOT_COOKIE_ID}=${legacyAnonymousId}; Path=/`;

    await init();
    await logspot.track({ event: "Legacy Visitor" });

    const body = lastFetchBody(fetchMock);
    expect(logspot.getAnonymousId()).toBe(legacyAnonymousId);
    expect(body.anonymous_id).toBe(legacyAnonymousId);
    expect(body.user_id).toBeNull();
  });

  it("identify() POSTs to /identify with the right body", async () => {
    const aid = logspot.getAnonymousId();

    await logspot.identify("user_42", { plan: "pro" });

    const identifyCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/identify")
    );
    expect(identifyCall).toBeDefined();

    const [url, opts] = identifyCall!;
    expect(url).toBe("https://api.example.com/identify");
    expect((opts as RequestInit).method).toBe("POST");
    expect((opts as any).headers["x-logspot-pk"]).toBe(PUBLIC_KEY);

    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.anonymous_id).toBe(aid);
    expect(body.user_id).toBe("user_42");
    expect(body.traits).toEqual({ plan: "pro" });
    expect(typeof body.timestamp).toBe("string");
    expect(body.identity_verification).toBeUndefined();
  });

  it("identify() includes identity_verification when token is supplied", async () => {
    await logspot.identify("user_42", undefined, {
      identityVerification: { token: "jwt-token" },
    });

    const identifyCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/identify")
    );
    const body = JSON.parse((identifyCall![1] as RequestInit).body as string);
    expect(body.identity_verification).toEqual({ token: "jwt-token" });
  });

  it("subsequent track() calls after identify() use the identified userId", async () => {
    fetchMock.mockClear();
    await logspot.identify("user_42");

    await logspot.track({ event: "Activated" });

    const trackCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/i")
    );
    const body = JSON.parse((trackCall![1] as RequestInit).body as string);
    expect(body.user_id).toBe("user_42");
    expect(body.anonymous_id).toBe(logspot.getAnonymousId());
  });

  it("reset() rotates the anonymousId and clears identified user state", async () => {
    await logspot.identify("user_42");
    const before = logspot.getAnonymousId();
    expect(before).toBeTruthy();

    logspot.reset();
    fetchMock.mockClear();
    await logspot.track({ event: "Logged Out Pageview" });

    const after = logspot.getAnonymousId();
    const body = lastFetchBody(fetchMock);
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    expect(body.anonymous_id).toBe(after);
    expect(body.user_id).toBeNull();
  });
});

describe("@logspot/web - identify edge cases", () => {
  let fetchMock: ReturnType<typeof setupFetchMock>;

  beforeEach(() => {
    resetCookies();
    window.localStorage.clear();
    __resetInMemoryAnonymousIdForTests();
    fetchMock = setupFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("falls through to localStorage when cookiesDisabled is true", async () => {
    await init({ cookiesDisabled: true });
    const aid = logspot.getAnonymousId();

    expect(aid).toBeTruthy();
    expect(document.cookie.includes(LOGSPOT_ANONYMOUS_ID_KEY)).toBe(false);
    expect(window.localStorage.getItem(LOGSPOT_ANONYMOUS_ID_KEY)).toBe(aid);
  });

  it("does not migrate the legacy cookie when cookiesDisabled is true", async () => {
    document.cookie = `${LOGSPOT_COOKIE_ID}=legacy_xyz; Path=/`;

    await init({ cookiesDisabled: true });

    expect(logspot.getAnonymousId()).not.toBe("legacy_xyz");
  });

  it("ignores legacy lgspt_uid values longer than 64 chars", async () => {
    const oversized = "u" + "a".repeat(80);
    document.cookie = `${LOGSPOT_COOKIE_ID}=${oversized}; Path=/`;

    await init();

    const aid = logspot.getAnonymousId();
    expect(aid).not.toBe(oversized);
    expect(aid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("explicit identifyApiUrl wins over derivation from externalApiUrl", async () => {
    await init({
      externalApiUrl: "https://api.example.com/i",
      identifyApiUrl: "https://override.example.com/identify",
    });

    await logspot.identify("user_99");

    const identifyCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/identify")
    );
    expect(identifyCall).toBeDefined();
    expect(identifyCall![0]).toBe("https://override.example.com/identify");
  });

  it("fails closed (no cloud fallback) when externalApiUrl is not /i or /track", async () => {
    await init({ externalApiUrl: "https://api.example.com/custom" });

    const result = await logspot.identify("user_99");

    const identifyCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/identify")
    );
    expect(identifyCall).toBeUndefined();
    expect(result).toEqual({ ok: false, reason: "no_endpoint" });
  });

  it("identify('') and identify('   ') return missing_user_id without fetching", async () => {
    await init();
    fetchMock.mockClear();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const empty = await logspot.identify("");
    const blank = await logspot.identify("   ");

    expect(empty).toEqual({ ok: false, reason: "missing_user_id" });
    expect(blank).toEqual({ ok: false, reason: "missing_user_id" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });

  it("revenue() emits the reserved 'Payment' event with value + currency", async () => {
    await init();
    fetchMock.mockClear();

    await logspot.revenue(49.99, { currency: "usd", plan: "pro" });

    const trackCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/i")
    );
    expect(trackCall).toBeDefined();
    const body = JSON.parse((trackCall![1] as RequestInit).body as string);
    expect(body.name).toBe("Payment");
    expect(body.value).toBe(49.99);
    // currency passes through verbatim; the server canonicalizes to ISO-4217.
    expect(body.currency).toBe("usd");
    expect(body.metadata.plan).toBe("pro");
    expect(body.anonymous_id).toBe(logspot.getAnonymousId());
  });

  it("revenue() honors an event-name override", async () => {
    await init();
    fetchMock.mockClear();

    await logspot.revenue(10, { currency: "EUR", event: "Subscription" });

    const body = lastFetchBody(fetchMock);
    expect(body.name).toBe("Subscription");
    expect(body.value).toBe(10);
    expect(body.currency).toBe("EUR");
  });

  it("revenue() rejects a negative or non-finite amount without fetching", async () => {
    await init();
    fetchMock.mockClear();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await logspot.revenue(-5, { currency: "USD" });
    await logspot.revenue(NaN, { currency: "USD" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });

  it("track() without revenue fields omits value/currency from the wire", async () => {
    await init();
    fetchMock.mockClear();

    await logspot.track({ event: "Signup" });

    const body = lastFetchBody(fetchMock);
    expect(body).not.toHaveProperty("value");
    expect(body).not.toHaveProperty("currency");
  });

  it("returns a structured error result on Secure Mode 401 from the server", async () => {
    fetchMock.mockImplementation(async (url: RequestInfo) => {
      if (String(url).endsWith("/identify")) {
        return new Response(JSON.stringify({ message: "invalid_token" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    });

    await init();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await logspot.identify("user_42", undefined, {
      identityVerification: { token: "garbage" },
    });

    expect(result).toEqual({ ok: false, status: 401, reason: "invalid_token" });
  });
});

describe("@logspot/web - referrer URL privacy", () => {
  let fetchMock: ReturnType<typeof setupFetchMock>;

  const setReferrer = (value: string) => {
    Object.defineProperty(document, "referrer", {
      value,
      configurable: true,
    });
  };

  beforeEach(() => {
    resetCookies();
    window.localStorage.clear();
    __resetInMemoryAnonymousIdForTests();
    fetchMock = setupFetchMock();
  });

  afterEach(() => {
    setReferrer("");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("strips non-allow-listed referrer query params under stripQueryParams", async () => {
    setReferrer("https://mail.google.com/inbox?token=secret&utm_source=nl#x");
    await init({ stripQueryParams: true });
    fetchMock.mockClear();
    await logspot.track({ event: "Test" });

    const body = lastFetchBody(fetchMock);
    // PII param + hash gone; allow-listed attribution kept.
    expect(body.referrer).toBe("https://mail.google.com/inbox?utm_source=nl");
  });

  it("sends the referrer unchanged when stripQueryParams is off (default)", async () => {
    setReferrer("https://mail.google.com/inbox?token=secret");
    await init();
    fetchMock.mockClear();
    await logspot.track({ event: "Test" });

    const body = lastFetchBody(fetchMock);
    expect(body.referrer).toBe("https://mail.google.com/inbox?token=secret");
  });
});

describe("@logspot/web - identify adoption semantics", () => {
  let fetchMock: ReturnType<typeof setupFetchMock>;

  beforeEach(async () => {
    resetCookies();
    window.localStorage.clear();
    __resetInMemoryAnonymousIdForTests();
    fetchMock = setupFetchMock();
  });

  afterEach(() => {
    logspot.reset();
    vi.unstubAllGlobals();
  });

  it("does not adopt the user id when the server rejects identify", async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        new Response(String(url).includes("/identify") ? '{"message":"nope"}' : "{}", {
          status: String(url).includes("/identify") ? 401 : 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    await init();
    logspot.reset();

    const result = await logspot.identify("rejected_user");
    expect(result.ok).toBe(false);

    fetchMock.mockClear();
    await logspot.track({ event: "After Rejected Identify" });
    const trackCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/i")
    );
    expect(JSON.parse((trackCall![1] as RequestInit).body as string).user_id).toBeNull();
  });

  it("adopts the user id and sends first_touch traits on success", async () => {
    const firstTouch = { utm_source: "google", landing_url: "https://x.test/lp" };
    document.cookie = `lgspt_ft=${btoa(encodeURIComponent(JSON.stringify(firstTouch)))}; Path=/`;
    await init();
    logspot.reset();

    const result = await logspot.identify("accepted_user", { plan: "pro" });
    expect(result.ok).toBe(true);

    const identifyCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/identify")
    );
    const body = JSON.parse((identifyCall![1] as RequestInit).body as string);
    expect(body.user_id).toBe("accepted_user");
    expect(body.traits.plan).toBe("pro");
    expect(body.traits.first_touch).toEqual(firstTouch);

    fetchMock.mockClear();
    await logspot.track({ event: "After Identify" });
    const trackCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/i")
    );
    expect(JSON.parse((trackCall![1] as RequestInit).body as string).user_id).toBe(
      "accepted_user"
    );
  });
});
