import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Campaign } from "./campaign";
import { SdkConfig } from "./sdk-config";

vi.mock("./cookie", () => ({
  getCookie: vi.fn(() => null),
  setCookie: vi.fn(),
  eraseCookie: vi.fn(),
  LOGSPOT_COOKIE_ID: "lgspt_uid",
  ONE_DAY_IN_SECONDS: 86400,
  ONE_YEAR_IN_SECONDS: 360 * 86400,
}));

import { getCookie, setCookie } from "./cookie";
import { b64EncodeUnicode } from "./utils";

const baseConfig = (overrides: Partial<SdkConfig> = {}): SdkConfig => ({
  publicKey: "pk_test",
  ...overrides,
});

// Find the setCookie call for a given cookie name (or undefined if absent).
const setCookieCallFor = (name: string) =>
  vi.mocked(setCookie).mock.calls.find((call) => call[0].name === name)?.[0];

describe("Campaign cookie expiration", () => {
  beforeEach(() => {
    vi.mocked(setCookie).mockClear();
    window.history.replaceState({}, "", "/?utm_source=test");
  });

  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("uses the 7-day default when no expiration is configured", () => {
    new Campaign(baseConfig({ stickyCampaigns: true }));

    // Assert the sticky (current-touch) cookie specifically; the durable
    // first-touch cookie is written separately and has its own expiration.
    expect(setCookieCallFor("lgspt_c")?.expiresInSeconds).toBe(7 * 86400);
  });

  it("respects stickyCampaignsExpirationInSeconds", () => {
    new Campaign(
      baseConfig({
        stickyCampaigns: true,
        stickyCampaignsExpirationInSeconds: 60 * 86400,
      })
    );

    expect(setCookieCallFor("lgspt_c")?.expiresInSeconds).toBe(60 * 86400);
  });

  it("does not inherit cookieExpirationInSeconds (which is for the anonymous id)", () => {
    new Campaign(
      baseConfig({
        stickyCampaigns: true,
        cookieExpirationInSeconds: 365 * 86400,
      })
    );

    expect(setCookieCallFor("lgspt_c")?.expiresInSeconds).toBe(7 * 86400);
  });

  it("does not write the campaign cookie when stickyCampaigns is false", () => {
    new Campaign(
      baseConfig({
        stickyCampaigns: false,
        stickyCampaignsExpirationInSeconds: 60 * 86400,
      })
    );

    // The CURRENT-touch (sticky) cookie must not be written. The durable
    // first-touch cookie is independent of stickyCampaigns, so it may still be
    // written — assert specifically that the sticky cookie was skipped.
    expect(setCookieCallFor("lgspt_c")).toBeUndefined();
  });
});

describe("Campaign first-touch (durable, set-once)", () => {
  beforeEach(() => {
    vi.mocked(setCookie).mockClear();
    vi.mocked(getCookie).mockReset();
    vi.mocked(getCookie).mockReturnValue(null);
    window.history.replaceState({}, "", "/?utm_source=google&utm_medium=cpc");
  });

  afterEach(() => {
    window.history.replaceState({}, "", "/");
    vi.mocked(getCookie).mockReset();
    vi.mocked(getCookie).mockReturnValue(null);
  });

  it("writes the first-touch cookie on the first campaign visit, independent of stickyCampaigns", () => {
    new Campaign(baseConfig({ stickyCampaigns: false }));

    const ft = setCookieCallFor("lgspt_ft");
    expect(ft).toBeDefined();
    // 1-year expiration so it survives multi-session paths to purchase.
    expect(ft!.expiresInSeconds).toBe(365 * 86400);
  });

  it("captures the campaign params + landing url into the first-touch cookie", () => {
    const campaign = new Campaign(baseConfig());
    const ft = setCookieCallFor("lgspt_ft");
    expect(ft).toBeDefined();
    const decoded = JSON.parse(
      decodeURIComponent(atob(ft!.value))
    ) as Record<string, string>;
    expect(decoded.utm_source).toBe("google");
    expect(decoded.utm_medium).toBe("cpc");
    expect(decoded.landing_url).toContain("utm_source=google");
    // getFirstTouchParams reads the cookie back (mocked to null here → {}).
    expect(campaign.getFirstTouchParams()).toEqual({});
  });

  it("is SET-ONCE: does not overwrite an existing first-touch cookie", () => {
    // Simulate an already-recorded first-touch from an earlier session.
    const prior = b64EncodeUnicode(
      JSON.stringify({ utm_source: "facebook", referrer: "https://fb.com" })
    );
    vi.mocked(getCookie).mockImplementation((name: string) =>
      name === "lgspt_ft" ? prior : null
    );
    // This visit carries a DIFFERENT campaign source.
    window.history.replaceState({}, "", "/?utm_source=tiktok");

    const campaign = new Campaign(baseConfig());

    // First-touch cookie must NOT be re-written.
    expect(setCookieCallFor("lgspt_ft")).toBeUndefined();
    // And the durable first-touch still reflects the ORIGINAL source.
    expect(campaign.getFirstTouchParams()).toEqual({
      utm_source: "facebook",
      referrer: "https://fb.com",
    });
  });

  it("does not lock in an empty first-touch on a pure-direct first visit", () => {
    window.history.replaceState({}, "", "/");
    // jsdom default document.referrer is empty.
    new Campaign(baseConfig());
    expect(setCookieCallFor("lgspt_ft")).toBeUndefined();
  });

  it("ignores a same-site referrer (page 2 of a direct visit must not claim first-touch)", () => {
    window.history.replaceState({}, "", "/second-page");
    const sameSite = `${window.location.protocol}//${window.location.host}/first-page`;
    Object.defineProperty(document, "referrer", {
      value: sameSite,
      configurable: true,
    });

    new Campaign(baseConfig());
    expect(setCookieCallFor("lgspt_ft")).toBeUndefined();

    Object.defineProperty(document, "referrer", {
      value: "",
      configurable: true,
    });
  });

  it("records an external referrer as first-touch", () => {
    window.history.replaceState({}, "", "/landing");
    Object.defineProperty(document, "referrer", {
      value: "https://news.ycombinator.com/item?id=1",
      configurable: true,
    });

    new Campaign(baseConfig());
    const call = setCookieCallFor("lgspt_ft");
    expect(call).toBeDefined();

    Object.defineProperty(document, "referrer", {
      value: "",
      configurable: true,
    });
  });
});

describe("Sticky campaign on a new tagged link", () => {
  const stored = { utm_source: "x", utm_medium: "social", utm_campaign: "launch" };

  beforeEach(() => {
    vi.mocked(setCookie).mockClear();
    vi.mocked(getCookie).mockImplementation((name: string) =>
      name === "lgspt_c" ? b64EncodeUnicode(JSON.stringify(stored)) : null
    );
  });

  afterEach(() => {
    vi.mocked(getCookie).mockImplementation(() => null);
    window.history.replaceState({}, "", "/");
  });

  const landOn = (path: string) => {
    window.history.replaceState({}, "", path);
    return new Campaign(baseConfig({ stickyCampaigns: true }));
  };

  it("drops the remembered campaign when the visitor arrives on a ?ref= link", () => {
    const campaign = landOn("/?ref=newsletter-42");

    expect(campaign.getCampaignParams()).toEqual({});
    expect(setCookieCallFor("lgspt_c")?.value).toBe(b64EncodeUnicode("{}"));
  });

  it("replaces, not merges, the remembered campaign on a new UTM link", () => {
    const campaign = landOn("/?utm_source=newsletter");

    expect(campaign.getCampaignParams()).toEqual({ utm_source: "newsletter" });
  });

  it("keeps the remembered campaign on an untagged page", () => {
    const campaign = landOn("/pricing");

    expect(campaign.getCampaignParams()).toEqual(stored);
  });
});
