// Delegated autocapture.
//
// One listener per capture type is attached to `document` (capture phase where
// it matters), and each handler walks up the DOM with `element.closest(...)`
// to find the meaningful element. This is additive: nothing here runs unless
// the host explicitly enables `autocapture` (or the legacy `enableAutoClicks`).
//
// Privacy posture:
// - Form submissions and input changes NEVER capture field values.
// - Sensitive inputs (passwords, OTP, credit-card, autofill credentials, or any
//   element flagged with `data-lgspt-sensitive`) are skipped entirely.

import type { RemoteConfig } from "./remote-config";
import type {
  AutocaptureConfig,
  AutocaptureSnippetConfig,
} from "./sdk-config";

/** Metadata bag forwarded to `track()`; values are JSON-serializable scalars. */
export type AutocaptureMetadata = Record<string, string | undefined>;

/** Shape `track()` expects from an autocaptured event. */
export type AutocaptureEvent = {
  event: string;
  metadata: AutocaptureMetadata;
};

/** Attribute used to fire a declarative event on click. */
export const DECLARATIVE_EVENT_ATTR = "data-lgspt-event";
/** Prefix for declarative metadata props, e.g. `data-lgspt-prop-plan="pro"`. */
export const DECLARATIVE_PROP_PREFIX = "data-lgspt-prop-";
/** Opt-out marker: an element (or ancestor) flagged sensitive is never read. */
export const SENSITIVE_ATTR = "data-lgspt-sensitive";

/**
 * File extensions treated as downloads. A click on an `a[href]` whose path ends
 * in one of these (case-insensitive) emits `File Downloaded`. Pure metadata —
 * no PII. (An explicit `download` attribute also qualifies, regardless of
 * extension.) This is the SDK's built-in default; the server config can replace
 * it per project.
 */
export const DOWNLOAD_EXTENSIONS: readonly string[] = [
  "pdf",
  "zip",
  "csv",
  "xlsx",
  "doc",
  "docx",
  "ppt",
  "pptx",
  "dmg",
  "pkg",
  "mp3",
  "mp4",
  "wav",
];

/**
 * Per-type defaults. `clicks` and `inputChanges` are noisy, so they default
 * OFF; `outboundLinks`, `fileDownloads`, and `formSubmissions` are high-signal
 * and default ON (once autocapture itself is enabled — autocapture is still off
 * by default). `mediaPlayback` is audience-dependent (only relevant on pages
 * with native media), so it also defaults OFF.
 */
export const AUTOCAPTURE_DEFAULTS: Required<AutocaptureConfig> = {
  outboundLinks: true,
  fileDownloads: true,
  formSubmissions: true,
  clicks: false,
  inputChanges: false,
  mediaPlayback: false,
};

/** Max characters of captured text before we treat the element as non-atomic. */
const MAX_TEXT_LENGTH = 500;
/** Truncate captured text to this length in emitted metadata. */
const TEXT_SLICE = 200;

/**
 * Playback-progress milestones (as fractions of duration) that emit a discrete
 * `Media Progress` event the first time playback crosses each one. 100% is the
 * `ended`/`Media Completed` event, not a progress milestone.
 */
const MEDIA_PROGRESS_THRESHOLDS = [0.25, 0.5, 0.75] as const;

const isAutocaptureObject = (
  value: boolean | AutocaptureConfig | undefined
): value is AutocaptureConfig => typeof value === "object" && value !== null;

/** The per-type keys the SDK currently understands (server may carry more). */
const AUTOCAPTURE_TYPE_KEYS = [
  "outboundLinks",
  "fileDownloads",
  "formSubmissions",
  "clicks",
  "inputChanges",
  "mediaPlayback",
] as const;

/** Any object carrying a `master` or `types` key is the snippet shape. */
const isSnippetConfig = (
  value: object
): value is AutocaptureSnippetConfig =>
  "master" in value || "types" in value;

/**
 * Normalize the three accepted snippet input shapes into a single
 * `{ master, types }` form that separates master enablement from per-type
 * overrides:
 *
 * - `boolean` → `{ master: <bool>, types: {} }`.
 * - {@link AutocaptureConfig} (plain object) → `{ master: true, types: <obj> }`
 *   (the direct-`init()` convenience: passing an object means enable).
 * - {@link AutocaptureSnippetConfig} `{ master, types }` → passed through, with
 *   `master` possibly `undefined` (per-type-only attrs do NOT enable).
 * - `undefined` → `{ master: undefined, types: {} }`.
 *
 * Exported so the override-reporting path (`ac-overrides.ts`) can derive the
 * EXPLICIT snippet override set from the same normalization the resolver uses.
 */
export const normalizeSnippet = (
  snippet:
    | boolean
    | AutocaptureConfig
    | AutocaptureSnippetConfig
    | undefined
): { master: boolean | undefined; types: AutocaptureConfig } => {
  if (typeof snippet === "boolean") {
    return { master: snippet, types: {} };
  }
  if (typeof snippet !== "object" || snippet === null) {
    return { master: undefined, types: {} };
  }
  if (isSnippetConfig(snippet)) {
    return { master: snippet.master, types: snippet.types ?? {} };
  }
  // Plain AutocaptureConfig object: passing it enables autocapture.
  return { master: true, types: snippet };
};

/**
 * Effective autocapture config the listeners run against: the resolved per-type
 * toggles plus the resolved download-extension allowlist (server-provided when
 * present, else the built-in {@link DOWNLOAD_EXTENSIONS}). Extensions are
 * normalized (lowercase, no leading dot) for matching.
 */
export type EffectiveAutocaptureConfig = Required<AutocaptureConfig> & {
  downloadExtensions: readonly string[];
};

/** Normalize an extension for matching: lowercase + strip a single leading dot. */
const normalizeExtension = (ext: string): string =>
  ext.trim().replace(/^\./, "").toLowerCase();

/**
 * Resolve the EFFECTIVE config from three sources, merged **per key**.
 *
 * Enablement (master): `snippetMaster ?? server.enabled ?? false`. The snippet's
 * master is `true`/`false` only when explicitly set (`data-autocapture`, a
 * plain `init()` object, or `enableAutoClicks`); a bare per-type attribute
 * leaves it `undefined`, so it can override a type but never flips the master
 * on. When the master resolves OFF this returns `null` (no listeners attached) —
 * the fail-safe default when neither snippet nor server enables it.
 *
 * Per-type (applies only when the master is on): `snippetType ?? serverType ??
 * default`. A snippet value wins in either direction (on AND off); else the
 * server config (delivered on the track response, cached in localStorage); else
 * {@link AUTOCAPTURE_DEFAULTS}. Only `{ outboundLinks, fileDownloads,
 * formSubmissions, mediaPlayback }` are read from the server — `clicks` /
 * `inputChanges` are snippet-only, and any extra server keys (e.g. `notFound`)
 * are ignored.
 *
 * The legacy `enableAutoClicks` flag counts as a snippet-side `clicks: true`.
 */
export const resolveEffectiveAutocaptureConfig = (
  snippet: boolean | AutocaptureConfig | AutocaptureSnippetConfig | undefined,
  enableAutoClicks: boolean | undefined,
  remote: RemoteConfig | null | undefined
): EffectiveAutocaptureConfig | null => {
  const server = remote?.autocapture;
  const { master: snippetMaster, types: snippetTypes } =
    normalizeSnippet(snippet);

  // --- Enablement (snippet master ?? server.enabled ?? false) ---------------
  // The legacy `enableAutoClicks` flag is a snippet-side enable, but only when
  // the snippet did not already set the master explicitly.
  const snippetEnable =
    snippetMaster ?? (enableAutoClicks ? true : undefined);
  const serverEnable =
    typeof server?.enabled === "boolean" ? server.enabled : undefined;
  const enabled = snippetEnable ?? serverEnable ?? false;

  if (!enabled) {
    return null;
  }

  // --- Per-type (snippet ?? server ?? default) ------------------------------
  // Only the server-controllable types are read from the server config; extra
  // server keys (e.g. `notFound`, or a stray `spaPageviews`) are ignored.
  const serverTypes = (server?.types ?? {}) as Record<
    string,
    boolean | undefined
  >;
  const SERVER_TYPE_KEYS = new Set([
    "outboundLinks",
    "fileDownloads",
    "formSubmissions",
    "mediaPlayback",
  ]);

  const resolved = { ...AUTOCAPTURE_DEFAULTS };
  for (const key of AUTOCAPTURE_TYPE_KEYS) {
    const snippetValue = snippetTypes[key];
    const serverValue = SERVER_TYPE_KEYS.has(key) ? serverTypes[key] : undefined;
    resolved[key] =
      typeof snippetValue === "boolean"
        ? snippetValue
        : typeof serverValue === "boolean"
          ? serverValue
          : AUTOCAPTURE_DEFAULTS[key];
  }

  // Legacy back-compat: `enableAutoClicks` forces clicks on unless the snippet
  // object explicitly opted out of clicks.
  if (enableAutoClicks && snippetTypes.clicks === undefined) {
    resolved.clicks = true;
  }

  // --- Download extensions (server-provided list ?? built-in default) -------
  // Normalize for matching: lowercase + strip a leading dot. Fall back to the
  // built-in list when the server omits it or sends an empty array.
  const serverExtensions = server?.downloads?.extensions;
  const downloadExtensions =
    Array.isArray(serverExtensions) && serverExtensions.length > 0
      ? serverExtensions.map(normalizeExtension).filter(Boolean)
      : DOWNLOAD_EXTENSIONS;

  return { ...resolved, downloadExtensions };
};

/**
 * Wire up delegated autocapture listeners. Returns a teardown function that
 * removes every listener it added. The host passes `track` (already DNT/consent
 * aware) and `shouldTrack` (re-checked on every event so a later DNT/disable
 * still short-circuits). Declarative `data-lgspt-event` capture is always on
 * when autocapture is enabled.
 */
export const setupAutocapture = (params: {
  config: EffectiveAutocaptureConfig;
  track: (event: AutocaptureEvent) => void;
  shouldTrack: () => boolean;
  doc?: Document;
}): (() => void) => {
  const { config, track, shouldTrack } = params;
  const doc = params.doc ?? document;

  const teardowns: Array<() => void> = [];

  const onClick = (event: Event) => {
    if (!shouldTrack()) return;
    const target = eventTarget(event);
    if (!target) return;
    // Honor the module contract: a flagged subtree is never read, clicks too.
    if (target.closest(`[${SENSITIVE_ATTR}]`)) return;

    // Declarative capture takes precedence and is always active.
    const declarative = findDeclarativeEvent(target);
    if (declarative) {
      track(declarative);
      return;
    }

    // Downloads are checked before outbound links: a download is the more
    // specific intent even when the file lives on another host.
    if (config.fileDownloads) {
      const download = buildDownloadEvent(target, doc, config.downloadExtensions);
      if (download) {
        track(download);
        return;
      }
    }

    if (config.outboundLinks) {
      const outbound = buildOutboundEvent(target, doc);
      if (outbound) {
        track(outbound);
        return;
      }
    }

    if (config.clicks) {
      const click = buildClickEvent(target);
      if (click) {
        track(click);
      }
    }
  };

  // Middle-button opens (auxclick) are still navigations for outbound links
  // and downloads; the plain click listener never sees them.
  const onAuxClick = (event: Event) => {
    if (!(event instanceof MouseEvent) || event.button !== 1) return;
    if (!shouldTrack()) return;
    const target = eventTarget(event);
    if (!target || target.closest(`[${SENSITIVE_ATTR}]`)) return;

    if (config.fileDownloads) {
      const download = buildDownloadEvent(target, doc, config.downloadExtensions);
      if (download) {
        track(download);
        return;
      }
    }
    if (config.outboundLinks) {
      const outbound = buildOutboundEvent(target, doc);
      if (outbound) {
        track(outbound);
      }
    }
  };

  const onSubmit = (event: Event) => {
    if (!shouldTrack()) return;
    if (!config.formSubmissions) return;
    const target = eventTarget(event);
    const form = target?.closest("form");
    if (!form) return;
    if (form.closest(`[${SENSITIVE_ATTR}]`)) return;
    track(buildFormEvent(form, doc));
  };

  const onChange = (event: Event) => {
    if (!shouldTrack()) return;
    if (!config.inputChanges) return;
    const target = eventTarget(event);
    const field = target?.closest("input, select, textarea");
    if (!field) return;
    if (isSensitiveField(field)) return;
    track(buildInputEvent(field));
  };

  // Per-element progress-milestone tracking, so each 25/50/75% threshold fires
  // at most once per playthrough. A WeakMap keys off the element itself (no leak
  // — entries vanish when the element is GC'd), and is reset when the element
  // seeks back to start or fires `ended`.
  const mediaMilestones = new WeakMap<HTMLMediaElement, Set<number>>();

  const mediaTarget = (event: Event): HTMLMediaElement | null => {
    const target = event.target;
    return target instanceof HTMLMediaElement ? target : null;
  };

  const onMediaPlay = (event: Event) => {
    if (!shouldTrack()) return;
    if (!config.mediaPlayback) return;
    const media = mediaTarget(event);
    if (!media || isSensitiveMedia(media)) return;
    track(buildMediaEvent(media, "Media Played"));
  };

  const onMediaPause = (event: Event) => {
    if (!shouldTrack()) return;
    if (!config.mediaPlayback) return;
    const media = mediaTarget(event);
    if (!media || isSensitiveMedia(media)) return;
    // The natural pause at the end of playback is reported by `ended` as a
    // completion — skip it here so it does not double up as a pause.
    if (media.ended) return;
    track(buildMediaEvent(media, "Media Paused"));
  };

  const onMediaTimeUpdate = (event: Event) => {
    if (!shouldTrack()) return;
    if (!config.mediaPlayback) return;
    const media = mediaTarget(event);
    if (!media || isSensitiveMedia(media)) return;

    const duration = media.duration;
    const currentTime = media.currentTime;
    // Live streams / not-yet-loaded media have no finite duration → no progress.
    if (!Number.isFinite(duration) || duration <= 0) return;

    let crossed = mediaMilestones.get(media);
    if (!crossed) {
      crossed = new Set();
      mediaMilestones.set(media, crossed);
    }

    // A seek back to the very start begins a fresh playthrough: reset milestones.
    if (currentTime <= 0 && crossed.size > 0) {
      crossed.clear();
    }

    const percent = currentTime / duration;
    for (const threshold of MEDIA_PROGRESS_THRESHOLDS) {
      if (percent >= threshold && !crossed.has(threshold)) {
        crossed.add(threshold);
        track(
          buildMediaEvent(media, "Media Progress", String(Math.round(threshold * 100)))
        );
      }
    }
  };

  const onMediaEnded = (event: Event) => {
    if (!shouldTrack()) return;
    if (!config.mediaPlayback) return;
    const media = mediaTarget(event);
    if (!media || isSensitiveMedia(media)) return;
    // Completion ends the playthrough: clear milestones so a replay re-fires.
    mediaMilestones.delete(media);
    track(buildMediaEvent(media, "Media Completed", "100"));
  };

  // Click handling powers outbound links, generic clicks, AND declarative
  // events. Declarative capture is always active under autocapture, so the
  // click listener is always attached (outbound/generic clicks are gated
  // inside the handler by `config`).
  doc.addEventListener("click", onClick, true);
  teardowns.push(() => doc.removeEventListener("click", onClick, true));

  if (config.fileDownloads || config.outboundLinks) {
    doc.addEventListener("auxclick", onAuxClick, true);
    teardowns.push(() => doc.removeEventListener("auxclick", onAuxClick, true));
  }

  if (config.formSubmissions) {
    doc.addEventListener("submit", onSubmit, true);
    teardowns.push(() => doc.removeEventListener("submit", onSubmit, true));
  }

  if (config.inputChanges) {
    doc.addEventListener("change", onChange, true);
    teardowns.push(() => doc.removeEventListener("change", onChange, true));
  }

  // Media events (`play`/`pause`/`timeupdate`/`ended`) do NOT bubble, so we must
  // delegate on the capture phase to catch them on `document`.
  if (config.mediaPlayback) {
    doc.addEventListener("play", onMediaPlay, true);
    doc.addEventListener("pause", onMediaPause, true);
    doc.addEventListener("timeupdate", onMediaTimeUpdate, true);
    doc.addEventListener("ended", onMediaEnded, true);
    teardowns.push(() => {
      doc.removeEventListener("play", onMediaPlay, true);
      doc.removeEventListener("pause", onMediaPause, true);
      doc.removeEventListener("timeupdate", onMediaTimeUpdate, true);
      doc.removeEventListener("ended", onMediaEnded, true);
    });
  }

  return () => {
    for (const teardown of teardowns) teardown();
  };
};

/** Narrow an event's target to an Element, or null for non-element targets. */
const eventTarget = (event: Event): Element | null => {
  const target = event.target;
  return target instanceof Element ? target : null;
};

/**
 * Declarative `data-lgspt-event` capture. Walks to the nearest ancestor (or
 * self) carrying the attribute and collects `data-lgspt-prop-*` props into
 * metadata. Supersedes the bare `lgspt-` classname approach.
 */
const findDeclarativeEvent = (target: Element): AutocaptureEvent | null => {
  const el = target.closest(`[${DECLARATIVE_EVENT_ATTR}]`);
  if (!(el instanceof HTMLElement)) return null;

  const eventName = el.getAttribute(DECLARATIVE_EVENT_ATTR);
  if (!eventName) return null;

  const metadata: AutocaptureMetadata = {};
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith(DECLARATIVE_PROP_PREFIX)) {
      const key = attr.name.slice(DECLARATIVE_PROP_PREFIX.length);
      if (key) metadata[key] = attr.value;
    }
  }

  return { event: eventName, metadata };
};

/**
 * Outbound-link capture. Fires only when the closest `a[href]` resolves to a
 * different host than the current page, and is not a same-page anchor / mailto
 * / tel link.
 */
const buildOutboundEvent = (
  target: Element,
  doc: Document
): AutocaptureEvent | null => {
  const resolved = resolveNavigableAnchor(target, doc);
  if (!resolved) return null;
  const { anchor, url } = resolved;

  if (!url.host || url.host === doc.location?.host) {
    return null;
  }

  return {
    event: "Outbound Link",
    metadata: {
      href: anchor.href || anchor.getAttribute("href") || undefined,
      text: elementText(anchor)?.slice(0, TEXT_SLICE),
    },
  };
};

// Shared by outbound-link and download capture: the nearest http(s) anchor
// that navigates (not a same-page hash or mailto/tel/sms/javascript scheme).
const resolveNavigableAnchor = (
  target: Element,
  doc: Document
): { anchor: HTMLAnchorElement; url: URL } | null => {
  const anchor = target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return null;

  const rawHref = anchor.getAttribute("href") ?? "";
  if (!rawHref) return null;
  if (
    rawHref.startsWith("#") ||
    /^(mailto:|tel:|sms:|javascript:)/i.test(rawHref)
  ) {
    return null;
  }

  // `anchor.href` is the resolved absolute URL in a real DOM; parse via URL
  // (with the page as base) so relative hrefs resolve correctly in jsdom too.
  let url: URL;
  try {
    url = new URL(anchor.href || rawHref, doc.location?.href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  return { anchor, url };
};

/**
 * File-download capture. Fires on a click of an `a[href]` that either carries a
 * `download` attribute or whose resolved path ends in a known download
 * extension. The extension allowlist is the effective config's
 * `downloadExtensions` (server-provided list when present, else the built-in
 * {@link DOWNLOAD_EXTENSIONS}); both the configured extensions and the URL's
 * extension are normalized (lowercase, no leading dot) for matching. Pure
 * metadata — `{ href, fileName, fileExtension }`, no PII. Same-page anchors and
 * non-navigational schemes (mailto/tel/sms/javascript) are never downloads.
 */
const buildDownloadEvent = (
  target: Element,
  doc: Document,
  extensions: readonly string[]
): AutocaptureEvent | null => {
  const resolved = resolveNavigableAnchor(target, doc);
  if (!resolved) return null;
  const { anchor, url } = resolved;

  const hasDownloadAttr = anchor.hasAttribute("download");
  // `fileExtensionFromPath` already lowercases; normalize the allowlist the
  // same way (lowercase + strip a leading dot) so a server-configured ".PDF"
  // still matches a `report.pdf`.
  const fileExtension = fileExtensionFromPath(url.pathname);
  const isKnownExtension =
    !!fileExtension &&
    extensions.some((ext) => normalizeExtension(ext) === fileExtension);

  if (!hasDownloadAttr && !isKnownExtension) {
    return null;
  }

  return {
    event: "File Downloaded",
    metadata: {
      href: anchor.href || anchor.getAttribute("href") || undefined,
      fileName: fileNameFromPath(url.pathname),
      fileExtension,
    },
  };
};

/** Form-submission capture. Metadata only — field values are never read. */
const buildFormEvent = (form: Element, doc: Document): AutocaptureEvent => ({
  event: "Form Submitted",
  metadata: {
    id: attr(form, "id"),
    name: attr(form, "name"),
    action: formAction(form, doc),
  },
});

// Content attribute, NOT form.action: the IDL attribute leaks the full page
// URL (query included) for action-less forms. Query/hash stripped on emit.
const formAction = (form: Element, doc: Document): string | undefined => {
  const rawAction = attr(form, "action");
  if (!rawAction) return undefined;
  try {
    const resolved = new URL(rawAction, doc.location?.href);
    return `${resolved.protocol}//${resolved.host}${resolved.pathname}`;
  } catch {
    return rawAction.split(/[?#]/)[0] || undefined;
  }
};

/**
 * Generic click capture (off by default). Targets the nearest interactive
 * element. Skips elements whose visible text exceeds {@link MAX_TEXT_LENGTH}
 * (the fixed length-guard: compares `.length`, not the string itself).
 */
const buildClickEvent = (target: Element): AutocaptureEvent | null => {
  const el = target.closest("a, button, [role=button]") ?? target;
  // Form controls can carry user or server-prefilled content in their subtree
  // (textarea default text, select option labels); never capture it.
  const text = el.matches("input, textarea, select, optgroup, option")
    ? undefined
    : elementText(el);

  if (text && text.length > MAX_TEXT_LENGTH) {
    return null;
  }

  return {
    event: "Click",
    metadata: {
      tag: el.tagName,
      id: attr(el, "id"),
      text: text?.slice(0, TEXT_SLICE),
      href: el instanceof HTMLAnchorElement ? el.href || undefined : undefined,
    },
  };
};

/** Input-change capture. Metadata only — the value is NEVER captured. */
const buildInputEvent = (field: Element): AutocaptureEvent => ({
  event: "Input Changed",
  metadata: {
    name: attr(field, "name"),
    type: fieldType(field),
  },
});

/**
 * Native `<video>`/`<audio>` engagement capture (metadata only — never a
 * recording). `percent` is set only for `Media Progress` (the milestone) and
 * `Media Completed` (`"100"`). `duration`/`current_time` are rounded whole
 * seconds; `duration` is omitted for non-finite values (e.g. live streams). The
 * `src` is the element `id` when present, else the basename of `currentSrc`/
 * `src` (filename only — query string dropped to avoid leaking URLs/PII).
 */
const buildMediaEvent = (
  media: HTMLMediaElement,
  event: string,
  percent?: string
): AutocaptureEvent => {
  const duration = media.duration;
  return {
    event,
    metadata: {
      media_type: media instanceof HTMLVideoElement ? "video" : "audio",
      src: mediaSource(media),
      title: mediaTitle(media),
      percent,
      duration: Number.isFinite(duration)
        ? String(Math.round(duration))
        : undefined,
      current_time: String(Math.round(media.currentTime)),
    },
  };
};

/**
 * Whether a media element is flagged sensitive and must be skipped. Mirrors the
 * input opt-out: the element itself or any ancestor carrying
 * `data-lgspt-sensitive`.
 */
const isSensitiveMedia = (media: Element): boolean =>
  media.closest(`[${SENSITIVE_ATTR}]`) !== null;

/**
 * Stable identifier for a media element: its `id` when present, else the
 * basename (filename only, query string dropped) of `currentSrc`/`src`. Returns
 * undefined when there is no usable source — never the full URL, to avoid
 * leaking PII in query params.
 */
const mediaSource = (media: HTMLMediaElement): string | undefined => {
  const id = attr(media, "id");
  if (id) return id;

  const raw = media.currentSrc || media.src;
  if (!raw) return undefined;
  return urlBasename(raw);
};

/**
 * Best-effort human label for a media element: `aria-label`, else the `title`
 * attribute, else the nearest `<label>`/`<figcaption>` text, else the source
 * filename. Truncated to {@link TEXT_SLICE}. Undefined when nothing is found.
 */
const mediaTitle = (media: HTMLMediaElement): string | undefined => {
  const ariaLabel = attr(media, "aria-label");
  if (ariaLabel) return ariaLabel.slice(0, TEXT_SLICE);

  const title = attr(media, "title");
  if (title) return title.slice(0, TEXT_SLICE);

  // Nearest `<figcaption>` (inside an ancestor `<figure>`) or an ancestor
  // `<label>`'s text. Pure structural metadata — no field/track text content.
  const figcaption = media.closest("figure")?.querySelector("figcaption");
  const captionText = figcaption ? elementText(figcaption) : undefined;
  if (captionText) return captionText.slice(0, TEXT_SLICE);

  const label = media.closest("label");
  const labelText = label ? elementText(label) : undefined;
  if (labelText) return labelText.slice(0, TEXT_SLICE);

  // Fall back to the source filename (already query-stripped).
  const raw = media.currentSrc || media.src;
  return raw ? urlBasename(raw) : undefined;
};

/**
 * Filename (last path segment) of a URL, with the query string and hash
 * dropped. Resolves relative to the page so jsdom and the browser agree.
 * Returns undefined when there is no meaningful segment.
 */
const urlBasename = (raw: string): string | undefined => {
  try {
    const url = new URL(raw, document.location?.href);
    return fileNameFromPath(url.pathname);
  } catch {
    // Not a parseable URL (e.g. a bare token): strip any query/hash by hand and
    // take the last path segment.
    const withoutQuery = raw.split(/[?#]/)[0];
    return fileNameFromPath(withoutQuery);
  }
};

/**
 * Whether an input/select/textarea is sensitive and must be skipped. Covers
 * password fields, one-time codes, credit-card autofill, stored credentials,
 * and any element (or ancestor) marked `data-lgspt-sensitive`.
 */
const isSensitiveField = (field: Element): boolean => {
  if (field.closest(`[${SENSITIVE_ATTR}]`)) {
    return true;
  }

  const type = (field.getAttribute("type") ?? "").toLowerCase();
  if (type === "password") {
    return true;
  }

  const autocomplete = (field.getAttribute("autocomplete") ?? "").toLowerCase();
  if (autocomplete) {
    if (
      autocomplete.includes("one-time-code") ||
      autocomplete.includes("current-password") ||
      autocomplete.includes("new-password") ||
      autocomplete.includes("cc-")
    ) {
      return true;
    }
  }

  return false;
};

/**
 * Last path segment of a URL pathname (the file name), decoded and trimmed of
 * trailing slashes. Returns undefined when there is no meaningful segment.
 */
const fileNameFromPath = (pathname: string): string | undefined => {
  const segments = pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return undefined;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

/**
 * Lower-cased extension (without the dot) of a URL pathname's file name, or
 * undefined when there is no dotted extension.
 */
const fileExtensionFromPath = (pathname: string): string | undefined => {
  const fileName = fileNameFromPath(pathname);
  if (!fileName) return undefined;
  const dot = fileName.lastIndexOf(".");
  // No dot, leading dot (dotfile, no real extension), or trailing dot → none.
  if (dot <= 0 || dot === fileName.length - 1) return undefined;
  return fileName.slice(dot + 1).toLowerCase();
};

const fieldType = (field: Element): string | undefined => {
  const explicit = field.getAttribute("type");
  if (explicit) return explicit;
  // Selects/textareas have no `type` attribute; fall back to the tag name.
  return field.tagName.toLowerCase();
};

const attr = (el: Element, name: string): string | undefined => {
  const value = el.getAttribute(name);
  return value === null || value === "" ? undefined : value;
};

/** Visible text of an element, trimmed. Returns undefined when empty. */
const elementText = (el: Element): string | undefined => {
  const raw =
    (el instanceof HTMLElement ? el.innerText : null) ?? el.textContent ?? "";
  const text = raw.trim();
  return text.length ? text : undefined;
};
