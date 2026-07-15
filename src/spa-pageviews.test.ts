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

const PUBLIC_KEY = "pk_test_spa";

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

/** All Pageview events sent so far, newest last (their full bodies). */
const pageviewBodies = (fetchMock: Mock) =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith("/i"))
    .map(([, opts]) => JSON.parse((opts as RequestInit).body as string))
    .filter((body) => body.name === "Pageview");

const pageviewCount = (fetchMock: Mock) => pageviewBodies(fetchMock).length;

// `enableAutoPageviews` is on so the initial pageview + SPA route-changes fire.
const init = async (config: Record<string, unknown> = {}) => {
  await logspot.init({
    publicKey: PUBLIC_KEY,
    enableAutoPageviews: true,
    externalApiUrl: "https://api.example.com/i",
    ...config,
  });
};

describe("@logspot/web - SPA pageviews (History-API, default)", () => {
  let fetchMock: ReturnType<typeof setupFetchMock>;

  beforeEach(() => {
    resetCookies();
    window.localStorage.clear();
    __resetInMemoryAnonymousIdForTests();
    document.body.innerHTML = "";
    // Reset the URL to a known path between tests.
    window.history.replaceState({}, "", "/");
    fetchMock = setupFetchMock();
  });

  afterEach(() => {
    logspot.reset();
    window.history.replaceState({}, "", "/");
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fires the initial pageview on init", async () => {
    await init();
    expect(pageviewCount(fetchMock)).toBe(1);
  });

  it("pushState fires a pageview for the new route", async () => {
    await init();
    fetchMock.mockClear();

    window.history.pushState({}, "", "/dashboard");

    expect(pageviewCount(fetchMock)).toBe(1);
    expect(pageviewBodies(fetchMock)[0].url).toBe("/dashboard");
  });

  it("replaceState fires a pageview for the new route", async () => {
    await init();
    fetchMock.mockClear();

    window.history.replaceState({}, "", "/settings");

    expect(pageviewCount(fetchMock)).toBe(1);
    expect(pageviewBodies(fetchMock)[0].url).toBe("/settings");
  });

  it("popstate (back/forward) fires a pageview", async () => {
    // Capture the native replaceState BEFORE init patches it, so we can change
    // the URL silently (as a browser back/forward navigation would) and then
    // dispatch popstate — without our pushState/replaceState patch firing first.
    const nativeReplaceState = window.history.replaceState.bind(window.history);

    await init();
    window.history.pushState({}, "", "/a");
    window.history.pushState({}, "", "/b");
    fetchMock.mockClear();

    // Browser "back" to /a: URL changes natively, then popstate fires.
    nativeReplaceState({}, "", "/a");
    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(pageviewCount(fetchMock)).toBe(1);
    expect(pageviewBodies(fetchMock)[0].url).toBe("/a");
  });

  it("hashchange (hash routers) fires a pageview", async () => {
    const nativeReplaceState = window.history.replaceState.bind(window.history);

    await init();
    window.history.replaceState({}, "", "/app");
    fetchMock.mockClear();

    // A hash router changes the hash natively, then dispatches hashchange.
    nativeReplaceState({}, "", "/app#/section");
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    expect(pageviewCount(fetchMock)).toBe(1);
    expect(pageviewBodies(fetchMock)[0].url).toBe("/app#/section");
  });

  it("dedupes a route change whose URL equals the last-tracked URL", async () => {
    await init();
    window.history.pushState({}, "", "/page");
    fetchMock.mockClear();

    // A replaceState to the same URL (e.g. normalization) must NOT double-count.
    window.history.replaceState({}, "", "/page");
    expect(pageviewCount(fetchMock)).toBe(0);

    // A popstate that resolves to the same URL is also ignored.
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(pageviewCount(fetchMock)).toBe(0);
  });

  it("sets the referrer to the previous route on a route change", async () => {
    await init();
    window.history.pushState({}, "", "/first");
    fetchMock.mockClear();

    window.history.pushState({}, "", "/second");
    const body = pageviewBodies(fetchMock)[0];
    expect(body.url).toBe("/second");
    expect(body.referrer).toBe("/first");
  });

  it("keeps firing SPA pageviews after reset (reset is identity-only)", async () => {
    await init();
    window.history.pushState({}, "", "/before-reset");

    logspot.reset();
    fetchMock.mockClear();

    window.history.pushState({}, "", "/after-reset");
    const body = pageviewBodies(fetchMock)[0];
    expect(body.url).toBe("/after-reset");
  });

  it("does not patch history or fire SPA pageviews when enableAutoPageviews is false", async () => {
    const originalPush = window.history.pushState;
    await init({ enableAutoPageviews: false });
    // We only patch history to drive auto-pageviews; with them off, leave it.
    expect(window.history.pushState).toBe(originalPush);
    fetchMock.mockClear();

    window.history.pushState({}, "", "/nope");
    expect(pageviewCount(fetchMock)).toBe(0);
  });

  it("does not clobber another library's history patch on reset", async () => {
    await init();
    // Another library patches pushState AFTER us (chaining through ours).
    const ourPatched = window.history.pushState;
    const theirPatched = function (
      this: History,
      ...args: Parameters<History["pushState"]>
    ) {
      return ourPatched.apply(this, args);
    };
    window.history.pushState = theirPatched;

    logspot.reset();
    // Our teardown must leave their patch in place (not restore over it).
    expect(window.history.pushState).toBe(theirPatched);
  });
});

describe("@logspot/web - SPA pageviews (legacy MutationObserver fallback)", () => {
  let fetchMock: ReturnType<typeof setupFetchMock>;

  beforeEach(() => {
    resetCookies();
    window.localStorage.clear();
    __resetInMemoryAnonymousIdForTests();
    document.body.innerHTML = "";
    window.history.replaceState({}, "", "/");
    fetchMock = setupFetchMock();
  });

  afterEach(() => {
    logspot.reset();
    window.history.replaceState({}, "", "/");
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does NOT patch history methods in legacy mode", async () => {
    const originalPush = window.history.pushState;
    await init({ legacySpaDetection: true });
    // Legacy mode leaves history untouched (uses a MutationObserver instead).
    expect(window.history.pushState).toBe(originalPush);
    logspot.reset();
    expect(window.history.pushState).toBe(originalPush);
  });

  it("detects a route change via DOM mutation + URL change", async () => {
    await init({ legacySpaDetection: true });
    fetchMock.mockClear();

    // Change the URL (without going through pushState — legacy mode does not
    // observe history), then mutate the body to trigger the observer.
    window.history.replaceState({}, "", "/legacy-route");
    document.body.appendChild(document.createElement("div"));
    // MutationObserver callbacks are microtask-scheduled; flush them.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pageviewCount(fetchMock)).toBe(1);
    expect(pageviewBodies(fetchMock)[0].url).toBe("/legacy-route");
  });
});
