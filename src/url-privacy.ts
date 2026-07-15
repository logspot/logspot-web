// Client-side URL query-parameter stripping — defense-in-depth for the server's
// authoritative per-project stripping. When enabled via `SdkConfig`, the SDK
// removes query params not in the allowlist (and always the hash) from the event
// url BEFORE sending, so PII/secrets in the query string never cross the wire.
//
// UTM/campaign attribution is unaffected: campaign.ts reads `window.location`
// directly, not the (stripped) payload url.

export const DEFAULT_QUERY_PARAM_ALLOWLIST = [
  "utm_source",
  "utm_id",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "ttclid",
  "ref",
];

const hasScheme = (value: string): boolean =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(value);

/**
 * Remove non-allow-listed query params (and always the hash) from `rawUrl`.
 * - Matching is case-insensitive on the param NAME; kept params preserve their
 *   original order, repeats, and values.
 * - Relative URLs are supported (the sentinel base is stripped back off).
 * - Never throws and never returns a broken url: on parse failure it returns the
 *   original string (the server still strips authoritatively).
 */
export const stripUrl = (
  rawUrl: string | null | undefined,
  allowlist: readonly string[] = DEFAULT_QUERY_PARAM_ALLOWLIST,
): string | null | undefined => {
  if (!rawUrl) return rawUrl;
  try {
    const allow = new Set(allowlist.map((name) => name.toLowerCase()));
    const absolute = hasScheme(rawUrl);
    const parsed = new URL(rawUrl, absolute ? undefined : "http://x.invalid");

    const kept = new URLSearchParams();
    parsed.searchParams.forEach((value, key) => {
      if (allow.has(key.toLowerCase())) kept.append(key, value);
    });

    const search = kept.toString();
    const path = `${parsed.pathname}${search ? `?${search}` : ""}`;
    // protocol//host, not origin: non-special schemes (android-app://) have
    // the literal origin "null", which would corrupt referrer attribution.
    return absolute ? `${parsed.protocol}//${parsed.host}${path}` : path;
  } catch {
    return rawUrl;
  }
};
