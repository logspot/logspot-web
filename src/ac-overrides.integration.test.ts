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
import { AC_OVERRIDES_KEY_PREFIX } from "./ac-overrides";

const PUBLIC_KEY = "pk_test_acov_integration";

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

/** Track (`/i`) bodies so far, newest last. */
const trackBodies = (fetchMock: Mock) =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith("/i"))
    .map(([, opts]) => JSON.parse((opts as RequestInit).body as string));

const init = async (config: Record<string, unknown> = {}) => {
  await logspot.init({
    publicKey: PUBLIC_KEY,
    enableAutoPageviews: false,
    externalApiUrl: "https://api.example.com/i",
    ...config,
  });
};

describe("@logspot/web — _acOverrides reporting", () => {
  let fetchMock: ReturnType<typeof setupFetchMock>;

  beforeEach(() => {
    resetCookies();
    window.localStorage.clear();
    __resetInMemoryAnonymousIdForTests();
    fetchMock = setupFetchMock();
  });

  afterEach(() => {
    logspot.reset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("attaches _acOverrides on the first event for an overriding snippet, deduped after", async () => {
    await init({
      autocapture: { master: true, types: { outboundLinks: false } },
    });

    await logspot.track({ event: "A" });
    await logspot.track({ event: "B" });

    const bodies = trackBodies(fetchMock);
    expect(bodies).toHaveLength(2);

    // First event carries the override report.
    expect(bodies[0]._acOverrides).toEqual({
      snippet: { master: true, types: { outboundLinks: false } },
      url: expect.any(String),
    });
    // Second (same fingerprint) does NOT.
    expect(bodies[1]).not.toHaveProperty("_acOverrides");

    // And the fingerprint was persisted under the namespaced key.
    expect(
      window.localStorage.getItem(`${AC_OVERRIDES_KEY_PREFIX}${PUBLIC_KEY}`)
    ).toBeTruthy();
  });

  it("never re-sends a fingerprint already stored from a previous load", async () => {
    // Simulate a prior load that already reported this exact override set.
    await init({
      autocapture: { master: true, types: { outboundLinks: false } },
    });
    await logspot.track({ event: "first-load" });
    expect(trackBodies(fetchMock)[0]).toHaveProperty("_acOverrides");

    // New "page load": re-init with the same snippet, fresh fetch mock. The
    // stored fingerprint (kept in localStorage) suppresses a re-send.
    fetchMock.mockClear();
    await init({
      autocapture: { master: true, types: { outboundLinks: false } },
    });
    await logspot.track({ event: "second-load" });

    const body = trackBodies(fetchMock)[0];
    expect(body).not.toHaveProperty("_acOverrides");
  });

  it("sends NOTHING when the snippet never overrode anything", async () => {
    await init(); // no autocapture config at all

    await logspot.track({ event: "A" });

    const body = trackBodies(fetchMock)[0];
    expect(body).not.toHaveProperty("_acOverrides");
    // No fingerprint stored either.
    expect(
      window.localStorage.getItem(`${AC_OVERRIDES_KEY_PREFIX}${PUBLIC_KEY}`)
    ).toBeNull();
  });

  it("sends a clear report once when overrides are removed after a prior report", async () => {
    // Prior load reported an override set.
    await init({ autocapture: { master: true } });
    await logspot.track({ event: "with-overrides" });
    expect(trackBodies(fetchMock)[0]).toHaveProperty("_acOverrides");

    // Next load: snippet no longer sets autocapture. Stored fingerprint is
    // non-empty → send a single clear report (empty types, no master).
    fetchMock.mockClear();
    logspot.reset();
    await init(); // no autocapture
    await logspot.track({ event: "cleared-1" });
    await logspot.track({ event: "cleared-2" });

    const bodies = trackBodies(fetchMock);
    expect(bodies[0]._acOverrides).toEqual({ snippet: { types: {} } });
    expect(bodies[1]).not.toHaveProperty("_acOverrides");

    // Fingerprint is cleared from storage.
    expect(
      window.localStorage.getItem(`${AC_OVERRIDES_KEY_PREFIX}${PUBLIC_KEY}`)
    ).toBeNull();
  });

  it("reports the master from the legacy enableAutoClicks flag", async () => {
    await init({ enableAutoClicks: true });

    await logspot.track({ event: "A" });

    const body = trackBodies(fetchMock)[0];
    expect(body._acOverrides).toEqual({
      snippet: { master: true },
      url: expect.any(String),
    });
  });

  it("does not break tracking when the override storage throws", async () => {
    await init({ autocapture: { master: true } });

    // Make ONLY the ac-overrides key throw (other keys, e.g. DNT/anon-id, are
    // untouched) so the override report path hits a storage failure mid-track.
    const realGetItem = Storage.prototype.getItem;
    const spy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(function (this: Storage, key: string) {
        if (key.startsWith(AC_OVERRIDES_KEY_PREFIX)) {
          throw new Error("storage unavailable");
        }
        return realGetItem.call(this, key);
      });

    // Tracking must still succeed (no throw); the report is best-effort.
    await expect(logspot.track({ event: "A" })).resolves.toBeUndefined();
    expect(trackBodies(fetchMock)).toHaveLength(1);

    spy.mockRestore();
  });
});
