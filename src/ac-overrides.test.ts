import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AC_OVERRIDES_KEY_PREFIX,
  buildSnippetOverrideReport,
  computeOverrideFingerprint,
  hasSnippetOverrides,
  readReportedFingerprint,
  resolveAcOverridesToReport,
  writeReportedFingerprint,
  clearReportedFingerprint,
  type SnippetOverrideReport,
} from "./ac-overrides";

const PUBLIC_KEY = "pk_test_acov";

describe("ac-overrides — buildSnippetOverrideReport", () => {
  it("includes master:true only when the snippet set the master on", () => {
    const report = buildSnippetOverrideReport(
      { master: true, types: {} },
      undefined
    );
    expect(report).toEqual({ master: true });
  });

  it("maps an explicit master-off to master:false", () => {
    const report = buildSnippetOverrideReport(
      { master: false, types: {} },
      undefined
    );
    expect(report).toEqual({ master: false });
  });

  it("omits master when only per-type attributes are present", () => {
    const report = buildSnippetOverrideReport(
      { master: undefined, types: { outboundLinks: false } },
      undefined
    );
    expect(report).toEqual({ types: { outboundLinks: false } });
    expect("master" in report).toBe(false);
  });

  it("includes only the server-controllable types the snippet set", () => {
    const report = buildSnippetOverrideReport(
      {
        master: undefined,
        types: {
          outboundLinks: true,
          fileDownloads: false,
          // clicks / inputChanges are snippet-only and must not be reported.
          clicks: true,
          inputChanges: false,
        },
      },
      undefined
    );
    expect(report).toEqual({
      types: { outboundLinks: true, fileDownloads: false },
    });
  });

  it("reports an explicit mediaPlayback override (server-controllable type)", () => {
    const report = buildSnippetOverrideReport(
      { master: undefined, types: { mediaPlayback: true } },
      undefined
    );
    expect(report).toEqual({ types: { mediaPlayback: true } });
  });

  it("treats enableAutoClicks as a snippet master-enable when master is unset", () => {
    const report = buildSnippetOverrideReport(
      { master: undefined, types: {} },
      true
    );
    expect(report).toEqual({ master: true });
  });

  it("does not let enableAutoClicks override an explicit master-off", () => {
    const report = buildSnippetOverrideReport(
      { master: false, types: {} },
      true
    );
    expect(report).toEqual({ master: false });
  });

  it("returns an empty report when the snippet set nothing", () => {
    const report = buildSnippetOverrideReport(
      { master: undefined, types: {} },
      undefined
    );
    expect(report).toEqual({});
    expect(hasSnippetOverrides(report)).toBe(false);
  });
});

describe("ac-overrides — computeOverrideFingerprint", () => {
  it("returns an empty string for the no-overrides report", () => {
    expect(computeOverrideFingerprint({})).toBe("");
  });

  it("is stable regardless of type-key insertion order", () => {
    const a: SnippetOverrideReport = {
      types: { fileDownloads: false, outboundLinks: true },
    };
    const b: SnippetOverrideReport = {
      types: { outboundLinks: true, fileDownloads: false },
    };
    expect(computeOverrideFingerprint(a)).toBe(computeOverrideFingerprint(b));
  });

  it("distinguishes master-off (false) from master absent", () => {
    expect(computeOverrideFingerprint({ master: false })).not.toBe(
      computeOverrideFingerprint({})
    );
    expect(computeOverrideFingerprint({ master: false })).not.toBe(
      computeOverrideFingerprint({ master: true })
    );
  });

  it("changes when a type value flips", () => {
    expect(
      computeOverrideFingerprint({ types: { outboundLinks: true } })
    ).not.toBe(computeOverrideFingerprint({ types: { outboundLinks: false } }));
  });
});

describe("ac-overrides — fingerprint storage (localStorage)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("round-trips a fingerprint under a per-public-key namespaced key", () => {
    writeReportedFingerprint(PUBLIC_KEY, "abc");
    expect(readReportedFingerprint(PUBLIC_KEY)).toBe("abc");
    expect(
      window.localStorage.getItem(`${AC_OVERRIDES_KEY_PREFIX}${PUBLIC_KEY}`)
    ).toBe("abc");
    // A different public key is isolated.
    expect(readReportedFingerprint("pk_other")).toBe("");
  });

  it("returns an empty string when nothing is stored", () => {
    expect(readReportedFingerprint(PUBLIC_KEY)).toBe("");
  });

  it("clearReportedFingerprint removes the entry", () => {
    writeReportedFingerprint(PUBLIC_KEY, "abc");
    clearReportedFingerprint(PUBLIC_KEY);
    expect(readReportedFingerprint(PUBLIC_KEY)).toBe("");
  });

  it("read never throws when getItem fails (returns empty string)", () => {
    const spy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("boom");
      });
    expect(() => readReportedFingerprint(PUBLIC_KEY)).not.toThrow();
    expect(readReportedFingerprint(PUBLIC_KEY)).toBe("");
    spy.mockRestore();
  });

  it("write is a no-op (no throw) when setItem fails", () => {
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    expect(() => writeReportedFingerprint(PUBLIC_KEY, "abc")).not.toThrow();
    spy.mockRestore();
  });

  it("ignores an empty public key", () => {
    writeReportedFingerprint("", "abc");
    expect(readReportedFingerprint("")).toBe("");
  });
});

describe("ac-overrides — resolveAcOverridesToReport (dedup + clear)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  const overrideReport: SnippetOverrideReport = {
    master: true,
    types: { outboundLinks: false },
  };

  it("reports a new override set once, then dedupes on the next call", () => {
    const first = resolveAcOverridesToReport({
      publicKey: PUBLIC_KEY,
      report: overrideReport,
      url: "https://example.com/page",
    });
    expect(first).toEqual({
      snippet: { master: true, types: { outboundLinks: false } },
      url: "https://example.com/page",
    });

    // Same override set → already reported → nothing to send.
    const second = resolveAcOverridesToReport({
      publicKey: PUBLIC_KEY,
      report: overrideReport,
      url: "https://example.com/other",
    });
    expect(second).toBeNull();
  });

  it("re-reports when the override set changes", () => {
    resolveAcOverridesToReport({ publicKey: PUBLIC_KEY, report: overrideReport });

    const changed: SnippetOverrideReport = {
      master: true,
      types: { outboundLinks: true },
    };
    const out = resolveAcOverridesToReport({
      publicKey: PUBLIC_KEY,
      report: changed,
    });
    expect(out).toEqual({
      snippet: { master: true, types: { outboundLinks: true } },
    });
  });

  it("sends nothing when never-overridden (common case)", () => {
    const out = resolveAcOverridesToReport({
      publicKey: PUBLIC_KEY,
      report: {},
    });
    expect(out).toBeNull();
  });

  it("sends a clear report ONCE after overrides are removed, then stops", () => {
    // First report an override set.
    resolveAcOverridesToReport({ publicKey: PUBLIC_KEY, report: overrideReport });

    // Now the snippet has no overrides → clear report (empty types, no master).
    const clear = resolveAcOverridesToReport({
      publicKey: PUBLIC_KEY,
      report: {},
      url: "https://example.com/page",
    });
    expect(clear).toEqual({ snippet: { types: {} } });
    expect("url" in (clear ?? {})).toBe(false);

    // The stored fingerprint is cleared, so a subsequent no-override call sends
    // nothing.
    const again = resolveAcOverridesToReport({
      publicKey: PUBLIC_KEY,
      report: {},
    });
    expect(again).toBeNull();
  });

  it("omits url when none is provided", () => {
    const out = resolveAcOverridesToReport({
      publicKey: PUBLIC_KEY,
      report: overrideReport,
    });
    expect(out).toEqual({
      snippet: { master: true, types: { outboundLinks: false } },
    });
    expect("url" in (out ?? {})).toBe(false);
  });

  it("returns null without a public key", () => {
    expect(
      resolveAcOverridesToReport({ publicKey: undefined, report: overrideReport })
    ).toBeNull();
    expect(
      resolveAcOverridesToReport({ publicKey: "", report: overrideReport })
    ).toBeNull();
  });
});
