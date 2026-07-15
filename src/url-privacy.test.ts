import { describe, expect, it } from "vitest";

import { DEFAULT_QUERY_PARAM_ALLOWLIST, stripUrl } from "./url-privacy";
import { removeQueryParamsFromUrl } from "./utils";

describe("stripUrl", () => {
  it("returns null/undefined/empty unchanged", () => {
    expect(stripUrl(null)).toBeNull();
    expect(stripUrl(undefined)).toBeUndefined();
    expect(stripUrl("")).toBe("");
  });

  it("leaves a url with no query untouched (hash still dropped)", () => {
    expect(stripUrl("https://acme.com/pricing")).toBe("https://acme.com/pricing");
    expect(stripUrl("https://acme.com/pricing#section")).toBe(
      "https://acme.com/pricing",
    );
  });

  it("drops non-allow-listed params, keeps allow-listed (default allowlist)", () => {
    expect(
      stripUrl("https://acme.com/p?email=jane@acme.com&utm_source=google#x"),
    ).toBe("https://acme.com/p?utm_source=google");
  });

  it("drops everything when nothing is allow-listed", () => {
    expect(stripUrl("https://acme.com/p?token=secret&sid=123")).toBe(
      "https://acme.com/p",
    );
  });

  it("honors a custom allowlist (case-insensitive on the name)", () => {
    expect(
      stripUrl("https://acme.com/p?Plan=pro&token=secret", ["plan"]),
    ).toBe("https://acme.com/p?Plan=pro");
  });

  it("preserves order, repeats, and encoded values of kept params", () => {
    expect(
      stripUrl(
        "https://acme.com/p?utm_source=a&drop=x&utm_source=b&utm_campaign=spring%20sale",
        ["utm_source", "utm_campaign"],
      ),
    ).toBe(
      "https://acme.com/p?utm_source=a&utm_source=b&utm_campaign=spring+sale",
    );
  });

  it("supports relative URLs without leaking a synthetic origin", () => {
    expect(stripUrl("/dashboard?id=42&utm_source=g")).toBe(
      "/dashboard?utm_source=g",
    );
    expect(stripUrl("/dashboard?id=42")).toBe("/dashboard");
  });

  it("returns the original string on unparseable input (never breaks the url)", () => {
    // `https://` has a scheme but no host → `new URL` throws; the helper must
    // fall back to the original rather than mangle or null it.
    expect(stripUrl("https://")).toBe("https://");
  });

  it("exposes a sensible default allowlist (UTM + click-ids + ref)", () => {
    expect(DEFAULT_QUERY_PARAM_ALLOWLIST).toContain("utm_source");
    expect(DEFAULT_QUERY_PARAM_ALLOWLIST).toContain("gclid");
    expect(DEFAULT_QUERY_PARAM_ALLOWLIST).toContain("ref");
  });
});

describe("stripUrl non-special schemes", () => {
  it("preserves android-app:// referrer hosts instead of the literal 'null' origin", () => {
    expect(stripUrl("android-app://com.google.android.gm/path?x=1")).toBe(
      "android-app://com.google.android.gm/path"
    );
  });
});

describe("removeQueryParamsFromUrl hash safety", () => {
  it("preserves the hash when it follows a query string", () => {
    expect(removeQueryParamsFromUrl("/pricing?plan=pro#faq", ["utm_source"])).toBe(
      "/pricing?plan=pro#faq"
    );
  });

  it("keeps the hash after stripping the only param", () => {
    expect(removeQueryParamsFromUrl("/pricing?utm_source=g#faq", ["utm_source"])).toBe(
      "/pricing#faq"
    );
  });

  it("leaves a hash-only URL untouched", () => {
    expect(removeQueryParamsFromUrl("/app#/section", ["utm_source"])).toBe(
      "/app#/section"
    );
  });
});
