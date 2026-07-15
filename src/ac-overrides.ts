// Observed snippet-override reporting.
//
// So the Logspot dashboard can surface "this setting is overridden by your
// installed snippet," the SDK reports the EXPLICIT snippet-level autocapture
// overrides it parsed (from the CDN `data-autocapture-*` attributes or an npm
// host-passed `autocapture` config) back to the server — but only once per
// distinct override set, NOT on every event.
//
// The report rides the existing `POST /i` track body as an optional
// `_acOverrides` field; it is metadata about config, not an event property, so
// it must never block or alter normal tracking. Everything here is best-effort
// and NEVER throws: a localStorage failure simply means we skip (or re-send)
// the report — tracking is unaffected either way.

import { safeLocalStorage } from "./safe-storage";

/**
 * The explicit snippet/install override set, as reported to the server. Only
 * keys the snippet/host EXPLICITLY set are present:
 *
 * - `master` — included only when the snippet set the master toggle
 *   (`data-autocapture` present, or npm `autocapture: boolean`); absent means
 *   "unset", so the boolean value is sent as-is (false = explicit master-OFF).
 * - `types` — included only when the snippet explicitly set at least one
 *   per-type override (or, in the CLEAR case, an empty object to clear the flag).
 *
 * A bare per-type attribute leaves `master` absent; a master-only snippet leaves
 * `types` absent. The common case (snippet set nothing) is an empty object `{}`.
 */
export type SnippetOverrideReport = {
  master?: boolean;
  types?: {
    outboundLinks?: boolean;
    fileDownloads?: boolean;
    formSubmissions?: boolean;
    mediaPlayback?: boolean;
  };
};

/** The optional `_acOverrides` field attached to the track body when reporting. */
export type AcOverridesReport = {
  snippet: SnippetOverrideReport;
  /** Sample URL where the override was observed (no hash needed). */
  url?: string;
};

/** localStorage key prefix; the public key is appended for per-project dedup. */
export const AC_OVERRIDES_KEY_PREFIX = "lgspt_acov_";

const keyFor = (publicKey: string): string =>
  `${AC_OVERRIDES_KEY_PREFIX}${publicKey}`;


/** The per-type keys the SDK reports (the server-controllable types). */
const REPORTED_TYPE_KEYS = [
  "outboundLinks",
  "fileDownloads",
  "formSubmissions",
  "mediaPlayback",
] as const;

/**
 * Build the EXPLICIT snippet-override report from the normalized snippet shape
 * (`{ master, types }` produced by `normalizeSnippet`) plus the legacy
 * `enableAutoClicks` flag. Only keys the snippet explicitly set are included:
 *
 * - `master` is included (as `true`/`false`) only when the snippet/host set it.
 *   `enableAutoClicks: true` counts as a snippet-side master-enable (matching the
 *   resolver), but only when the snippet did not already set the master.
 * - `types` is included only when the snippet explicitly set one of the
 *   server-controllable types (`outboundLinks` / `fileDownloads` /
 *   `formSubmissions` / `mediaPlayback`). `clicks` / `inputChanges` are
 *   snippet-only knobs the server doesn't model, so they are not reported.
 *
 * Returns an empty object `{}` when the snippet set nothing reportable (the
 * common case). `master` carries the explicit boolean; absent means unset.
 */
export const buildSnippetOverrideReport = (
  normalized: {
    master: boolean | undefined;
    types: Record<string, boolean | undefined>;
  },
  enableAutoClicks: boolean | undefined
): SnippetOverrideReport => {
  const report: SnippetOverrideReport = {};

  // Master: explicit snippet master, else the legacy enableAutoClicks enable
  // (only when the snippet did not already set the master). Absent otherwise.
  const master =
    typeof normalized.master === "boolean"
      ? normalized.master
      : enableAutoClicks
        ? true
        : undefined;
  if (typeof master === "boolean") {
    // Absence already encodes "unset"; send the boolean as-is. (The server's
    // zod `opt()` normalizes null to undefined, which would drop explicit-off.)
    report.master = master;
  }

  // Types: only the server-controllable types the snippet explicitly set.
  const types: NonNullable<SnippetOverrideReport["types"]> = {};
  for (const key of REPORTED_TYPE_KEYS) {
    const value = normalized.types[key];
    if (typeof value === "boolean") {
      types[key] = value;
    }
  }
  if (Object.keys(types).length > 0) {
    report.types = types;
  }

  return report;
};

/**
 * Whether a built report carries any explicit override (a master or any type).
 * The empty report `{}` means "the snippet overrode nothing."
 */
export const hasSnippetOverrides = (report: SnippetOverrideReport): boolean =>
  "master" in report || report.types !== undefined;

/**
 * Stable fingerprint of a snippet-override report: the JSON of the report with
 * type keys emitted in a fixed order, so logically-equal reports always produce
 * an identical string regardless of insertion order. Returns "" for the empty
 * (no-overrides) report.
 */
export const computeOverrideFingerprint = (
  report: SnippetOverrideReport
): string => {
  if (!hasSnippetOverrides(report)) {
    return "";
  }

  const canonical: { master?: boolean; types?: Record<string, boolean> } = {};
  if (typeof report.master === "boolean") {
    canonical.master = report.master;
  }
  if (report.types) {
    const orderedTypes: Record<string, boolean> = {};
    for (const key of REPORTED_TYPE_KEYS) {
      const value = report.types[key];
      if (typeof value === "boolean") {
        orderedTypes[key] = value;
      }
    }
    canonical.types = orderedTypes;
  }

  try {
    return JSON.stringify(canonical);
  } catch {
    return "";
  }
};

/** Read the last-reported fingerprint for a public key. Never throws; "" when absent. */
export const readReportedFingerprint = (publicKey: string): string => {
  if (!publicKey) return "";
  const ls = safeLocalStorage();
  if (!ls) return "";
  try {
    return ls.getItem(keyFor(publicKey)) ?? "";
  } catch {
    return "";
  }
};

/** Persist the last-reported fingerprint for a public key. Best-effort; never throws. */
export const writeReportedFingerprint = (
  publicKey: string,
  fingerprint: string
): void => {
  if (!publicKey) return;
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.setItem(keyFor(publicKey), fingerprint);
  } catch {
    // Quota / unavailable — ignore. Worst case we re-send next load.
  }
};

/** Remove the stored fingerprint for a public key. Never throws. */
export const clearReportedFingerprint = (publicKey: string): void => {
  if (!publicKey) return;
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.removeItem(keyFor(publicKey));
  } catch {
    // ignore
  }
};

/**
 * Decide whether to attach `_acOverrides` to the next track request, and update
 * the stored fingerprint so the same override set is reported at most once per
 * browser. All localStorage access is best-effort and never throws.
 *
 * Cases:
 * - Snippet has overrides AND the fingerprint differs from the last reported one
 *   → return the report (with `url`) and persist the new fingerprint.
 * - Snippet has NO overrides BUT a non-empty fingerprint was stored → send the
 *   CLEAR report once (`{ snippet: { types: {} } }`, no master) so the server
 *   clears the flag, then clear the stored fingerprint.
 * - Snippet has no overrides and nothing was previously reported → return null
 *   (send nothing — the common case).
 * - Fingerprint unchanged → return null (already reported).
 *
 * The store is updated synchronously here (before the request resolves) so a
 * second event in the same page load does not re-attach the report.
 */
export const resolveAcOverridesToReport = (params: {
  publicKey: string | undefined;
  report: SnippetOverrideReport;
  url?: string | null;
}): AcOverridesReport | null => {
  const { publicKey, report } = params;
  if (!publicKey) return null;

  try {
    const fingerprint = computeOverrideFingerprint(report);
    const lastReported = readReportedFingerprint(publicKey);

    // Already reported this exact set → nothing to do.
    if (fingerprint === lastReported) {
      return null;
    }

    // CLEAR case: snippet has no overrides now, but something was reported before.
    if (fingerprint === "") {
      clearReportedFingerprint(publicKey);
      return { snippet: { types: {} } };
    }

    // New / changed override set → report it and remember the fingerprint.
    writeReportedFingerprint(publicKey, fingerprint);
    const out: AcOverridesReport = { snippet: report };
    if (params.url) out.url = params.url;
    return out;
  } catch {
    // Any failure to compute/persist must never break tracking.
    return null;
  }
};
