import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logspot } from "./index";
import { __resetInMemoryAnonymousIdForTests } from "./anonymous-id";
import { hasExplicitDNT } from "./dnt";

const visit = (search: string) =>
  window.history.replaceState({}, "", `/${search}`);

describe("hasExplicitDNT", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => visit(""));

  it("opts out on ?dnt and remembers it", () => {
    visit("?dnt");
    expect(hasExplicitDNT()).toBe(true);
    visit("");
    expect(hasExplicitDNT()).toBe(true);
  });

  it("opts back in on ?dnt=false or ?dnt=0", () => {
    for (const value of ["false", "0"]) {
      visit("?dnt");
      hasExplicitDNT();
      visit(`?dnt=${value}`);
      expect(hasExplicitDNT(), value).toBe(false);
      visit("");
      expect(hasExplicitDNT(), value).toBe(false);
    }
  });
});

describe("automated browsers", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const setWebdriver = (value: boolean | undefined) =>
    Object.defineProperty(window.navigator, "webdriver", {
      configurable: true,
      get: () => value,
    });

  const init = (config: Record<string, unknown> = {}) =>
    logspot.init({
      publicKey: "pk_test_123",
      enableAutoPageviews: false,
      externalApiUrl: "https://api.example.com/i",
      ...config,
    });

  beforeEach(() => {
    window.localStorage.clear();
    __resetInMemoryAnonymousIdForTests();
    fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    setWebdriver(undefined);
    vi.unstubAllGlobals();
  });

  it("sends nothing from a WebDriver-controlled browser", async () => {
    setWebdriver(true);
    await init();
    await logspot.track({ event: "Signup" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tracks WebDriver browsers with trackAutomatedBrowsers", async () => {
    setWebdriver(true);
    await init({ trackAutomatedBrowsers: true });
    await logspot.track({ event: "Signup" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
