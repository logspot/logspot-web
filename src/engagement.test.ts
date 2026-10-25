import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logspot } from "./index";
import { __resetInMemoryAnonymousIdForTests } from "./anonymous-id";
import {
  HEARTBEAT_INTERVAL_MS,
  MAX_HEARTBEATS_PER_PAGE,
  MAX_LEAVES_PER_PAGE,
  setupEngagement,
} from "./engagement";
import { REMOTE_CONFIG_KEY_PREFIX } from "./remote-config";

let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", {
  configurable: true,
  get: () => visibility,
});
const setVisibility = (state: DocumentVisibilityState) => {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
};

describe("setupEngagement", () => {
  let clock = 0;
  const now = () => clock;
  const sent: Array<{ event: string; engaged_seconds: number }> = [];
  const send = (event: string, metadata: { engaged_seconds: number }) =>
    sent.push({ event, ...metadata });

  beforeEach(() => {
    clock = 0;
    sent.length = 0;
    visibility = "visible";
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports visible time once when the page is hidden", () => {
    const tracker = setupEngagement({ mode: "leave", send, now });
    clock = 42_400;
    setVisibility("hidden");
    window.dispatchEvent(new Event("pagehide"));
    expect(sent).toEqual([{ event: "Page Leave", engaged_seconds: 42 }]);
    tracker.teardown();
  });

  it("counts only visible time across tab switches", () => {
    const tracker = setupEngagement({ mode: "leave", send, now });
    clock = 10_000;
    setVisibility("hidden");
    clock = 500_000;
    setVisibility("visible");
    clock = 505_000;
    setVisibility("hidden");
    expect(sent.map((s) => s.engaged_seconds)).toEqual([10, 5]);
    tracker.teardown();
  });

  it("caps leave events per page and starts fresh on a route change", () => {
    const tracker = setupEngagement({ mode: "leave", send, now });
    for (let i = 0; i < MAX_LEAVES_PER_PAGE + 5; i++) {
      clock += 2_000;
      setVisibility("hidden");
      setVisibility("visible");
    }
    expect(sent).toHaveLength(MAX_LEAVES_PER_PAGE);
    clock += 3_000;
    tracker.pageChanged();
    expect(sent).toHaveLength(MAX_LEAVES_PER_PAGE);
    clock += 4_000;
    tracker.pageChanged();
    expect(sent.at(-1)).toEqual({ event: "Page Leave", engaged_seconds: 4 });
    tracker.teardown();
  });

  it("sends no heartbeat in leave mode", () => {
    const tracker = setupEngagement({ mode: "leave", send, now });
    clock = HEARTBEAT_INTERVAL_MS * 3;
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
    expect(sent).toEqual([]);
    tracker.teardown();
  });

  it("sends capped heartbeats only while visible in heartbeat mode", () => {
    const tracker = setupEngagement({ mode: "heartbeat", send, now });
    for (let i = 0; i < MAX_HEARTBEATS_PER_PAGE + 5; i++) {
      clock += HEARTBEAT_INTERVAL_MS;
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    }
    expect(sent.filter((s) => s.event === "Page Heartbeat")).toHaveLength(
      MAX_HEARTBEATS_PER_PAGE,
    );
    expect(sent[0]).toEqual({ event: "Page Heartbeat", engaged_seconds: 60 });

    sent.length = 0;
    setVisibility("hidden");
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);
    expect(sent.map((s) => s.event)).toEqual(["Page Leave"]);
    tracker.teardown();
  });

  it("stops listening after teardown", () => {
    const tracker = setupEngagement({ mode: "heartbeat", send, now });
    tracker.teardown();
    clock = 90_000;
    setVisibility("hidden");
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);
    expect(sent).toEqual([]);
  });
});

describe("engagement in the SDK", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const events = () =>
    fetchMock.mock.calls.map(
      (call) => JSON.parse((call[1] as RequestInit).body as string).name,
    );

  const init = (config: Record<string, unknown> = {}) =>
    logspot.init({
      publicKey: "pk_engage",
      enableAutoPageviews: false,
      externalApiUrl: "https://api.example.com/i",
      ...config,
    });

  const cacheRemote = (engagement: string) =>
    window.localStorage.setItem(
      `${REMOTE_CONFIG_KEY_PREFIX}pk_engage`,
      JSON.stringify({ cv: 1, ts: Date.now(), config: { v: 1, engagement } }),
    );

  beforeEach(() => {
    window.localStorage.clear();
    __resetInMemoryAnonymousIdForTests();
    visibility = "visible";
    fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await init({ engagement: "off" });
    vi.unstubAllGlobals();
  });

  it("is off by default", async () => {
    await init();
    await new Promise((r) => setTimeout(r, 1_100));
    setVisibility("hidden");
    setVisibility("visible");
    expect(events()).not.toContain("Page Leave");
  });

  it("follows the dashboard setting from remote config", async () => {
    cacheRemote("leave");
    await init();
    await new Promise((r) => setTimeout(r, 1_100));
    setVisibility("hidden");
    setVisibility("visible");
    await vi.waitFor(() => expect(events()).toContain("Page Leave"));
    const body = JSON.parse(
      (fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string,
    );
    expect(body.metadata.engaged_seconds).toBeGreaterThanOrEqual(1);
  });

  it("lets the snippet override the dashboard", async () => {
    cacheRemote("leave");
    await init({ engagement: "off" });
    await new Promise((r) => setTimeout(r, 1_100));
    setVisibility("hidden");
    setVisibility("visible");
    expect(events()).not.toContain("Page Leave");
  });
});
