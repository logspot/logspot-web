import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearRemoteConfig,
  readRemoteConfig,
  REMOTE_CONFIG_CACHE_VERSION,
  REMOTE_CONFIG_KEY_PREFIX,
  REMOTE_CONFIG_TTL_MS,
  writeRemoteConfig,
  type RemoteConfig,
} from "./remote-config";

const PUBLIC_KEY = "pk_test_remote_config";

const SAMPLE: RemoteConfig = {
  v: 1,
  autocapture: {
    enabled: true,
    types: {
      outboundLinks: true,
      fileDownloads: false,
      formSubmissions: true,
      notFound: false,
    },
    notFound: null,
    downloads: { extensions: ["pdf", "zip"] },
  },
};

describe("remote-config (localStorage helper)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("round-trips a config keyed by public key", () => {
    writeRemoteConfig(PUBLIC_KEY, SAMPLE);
    expect(readRemoteConfig(PUBLIC_KEY)).toEqual(SAMPLE);
  });

  it("stores under a per-public-key namespaced key", () => {
    writeRemoteConfig(PUBLIC_KEY, SAMPLE);
    expect(
      window.localStorage.getItem(`${REMOTE_CONFIG_KEY_PREFIX}${PUBLIC_KEY}`)
    ).toBeTruthy();
    // A different public key is isolated.
    expect(readRemoteConfig("pk_other")).toBeNull();
  });

  it("returns null when nothing is cached", () => {
    expect(readRemoteConfig(PUBLIC_KEY)).toBeNull();
  });

  it("returns null (never throws) on corrupt JSON", () => {
    window.localStorage.setItem(
      `${REMOTE_CONFIG_KEY_PREFIX}${PUBLIC_KEY}`,
      "{not valid json"
    );
    expect(() => readRemoteConfig(PUBLIC_KEY)).not.toThrow();
    expect(readRemoteConfig(PUBLIC_KEY)).toBeNull();
  });

  it("returns null for a wrong-shaped envelope", () => {
    window.localStorage.setItem(
      `${REMOTE_CONFIG_KEY_PREFIX}${PUBLIC_KEY}`,
      JSON.stringify({ nope: true })
    );
    expect(readRemoteConfig(PUBLIC_KEY)).toBeNull();
  });

  it("returns null for a stale (TTL-expired) entry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    writeRemoteConfig(PUBLIC_KEY, SAMPLE);
    expect(readRemoteConfig(PUBLIC_KEY)).toEqual(SAMPLE);

    // Advance past the TTL window.
    vi.setSystemTime(Date.now() + REMOTE_CONFIG_TTL_MS + 1000);
    expect(readRemoteConfig(PUBLIC_KEY)).toBeNull();
  });

  it("returns null when the cache-format version differs", () => {
    // Hand-write an envelope with a bumped cache version.
    window.localStorage.setItem(
      `${REMOTE_CONFIG_KEY_PREFIX}${PUBLIC_KEY}`,
      JSON.stringify({
        cv: REMOTE_CONFIG_CACHE_VERSION + 1,
        ts: Date.now(),
        config: SAMPLE,
      })
    );
    expect(readRemoteConfig(PUBLIC_KEY)).toBeNull();
  });

  it("clearRemoteConfig removes the entry", () => {
    writeRemoteConfig(PUBLIC_KEY, SAMPLE);
    clearRemoteConfig(PUBLIC_KEY);
    expect(readRemoteConfig(PUBLIC_KEY)).toBeNull();
  });

  it("write is a no-op (no throw) when setItem fails", () => {
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    expect(() => writeRemoteConfig(PUBLIC_KEY, SAMPLE)).not.toThrow();
    spy.mockRestore();
    // Nothing persisted.
    expect(readRemoteConfig(PUBLIC_KEY)).toBeNull();
  });

  it("ignores an empty public key", () => {
    writeRemoteConfig("", SAMPLE);
    expect(readRemoteConfig("")).toBeNull();
  });
});
