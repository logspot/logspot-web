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
import {
  __resetInMemoryAnonymousIdForTests,
} from "./anonymous-id";
import {
  AUTOCAPTURE_DEFAULTS,
  DOWNLOAD_EXTENSIONS,
  resolveEffectiveAutocaptureConfig,
} from "./autocapture";
import {
  clearRemoteConfig,
  writeRemoteConfig,
  type RemoteConfig,
} from "./remote-config";

const PUBLIC_KEY = "pk_test_autocapture";

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

/** Bodies of every track (`/i`) call so far, newest last. */
const trackBodies = (fetchMock: Mock) =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith("/i"))
    .map(([, opts]) => JSON.parse((opts as RequestInit).body as string));

/** The single event captured (asserts exactly one), or undefined if none. */
const onlyEvent = (fetchMock: Mock) => {
  const bodies = trackBodies(fetchMock);
  return bodies.length === 1 ? bodies[0] : undefined;
};

const init = async (config: Record<string, unknown> = {}) => {
  await logspot.init({
    publicKey: PUBLIC_KEY,
    enableAutoPageviews: false,
    externalApiUrl: "https://api.example.com/i",
    ...config,
  });
};

const click = (el: Element) => {
  // Prevent jsdom's default <a href> navigation (unimplemented; emits noisy
  // "Not implemented: navigation" warnings) while still exercising the
  // delegated capture-phase listener. A one-shot bubble-phase listener cancels
  // the event after our capture-phase handler has already run.
  const cancel = (event: Event) => event.preventDefault();
  document.addEventListener("click", cancel);
  el.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true })
  );
  document.removeEventListener("click", cancel);
};

const submit = (form: HTMLFormElement) =>
  form.dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true })
  );

const change = (el: Element) =>
  el.dispatchEvent(new Event("change", { bubbles: true }));

/**
 * jsdom does not implement real media playback, so we stub the read-only media
 * properties (`duration`/`currentTime`/`currentSrc`) and dispatch synthetic
 * media events. Media events (`play`/`pause`/`timeupdate`/`ended`) do not
 * bubble in real browsers; we set `bubbles: false` so the capture-phase
 * delegation on `document` is what's actually exercised.
 */
const stubMedia = (
  media: HTMLMediaElement,
  props: { duration?: number; currentTime?: number; currentSrc?: string }
) => {
  if ("duration" in props) {
    Object.defineProperty(media, "duration", {
      configurable: true,
      get: () => props.duration as number,
    });
  }
  if ("currentTime" in props) {
    Object.defineProperty(media, "currentTime", {
      configurable: true,
      get: () => props.currentTime as number,
    });
  }
  if ("currentSrc" in props) {
    Object.defineProperty(media, "currentSrc", {
      configurable: true,
      get: () => props.currentSrc as string,
    });
  }
};

const fireMedia = (
  media: HTMLMediaElement,
  type: "play" | "pause" | "timeupdate" | "ended"
) => media.dispatchEvent(new Event(type, { bubbles: false }));

describe("resolveEffectiveAutocaptureConfig (snippet ?? server ?? default)", () => {
  type ServerTypes = NonNullable<
    NonNullable<RemoteConfig["autocapture"]>["types"]
  >;
  const serverOn = (types: ServerTypes = {}): RemoteConfig => ({
    v: 1,
    autocapture: { enabled: true, types },
  });

  /**
   * The effective config carries the resolved per-type toggles plus a
   * `downloadExtensions` allowlist. This strips the extensions so the per-type
   * assertions can compare against {@link AUTOCAPTURE_DEFAULTS} (which has no
   * `downloadExtensions` key). The extensions are asserted separately.
   */
  const typesOnly = (
    resolved: ReturnType<typeof resolveEffectiveAutocaptureConfig>
  ) => {
    if (!resolved) return resolved;
    const { downloadExtensions, ...types } = resolved;
    return types;
  };

  it("returns null when neither snippet nor server enables (fail-safe OFF)", () => {
    expect(resolveEffectiveAutocaptureConfig(undefined, false, null)).toBeNull();
    expect(
      resolveEffectiveAutocaptureConfig(undefined, false, {
        v: 1,
        autocapture: { enabled: false },
      })
    ).toBeNull();
    // A server config with no `enabled` key falls back to OFF.
    expect(
      resolveEffectiveAutocaptureConfig(undefined, false, {
        v: 1,
        autocapture: { types: { outboundLinks: true } },
      })
    ).toBeNull();
  });

  it("server enables → applies server types over defaults", () => {
    const resolved = resolveEffectiveAutocaptureConfig(undefined, false, {
      v: 1,
      autocapture: {
        enabled: true,
        types: { formSubmissions: false },
      },
    });
    expect(typesOnly(resolved)).toEqual({
      outboundLinks: true, // default (server silent)
      fileDownloads: true, // default (server silent)
      formSubmissions: false, // server
      clicks: false, // default (clicks is snippet-only, not server-controlled)
      inputChanges: false, // default
      mediaPlayback: false, // default (server silent)
    });
  });

  it("server enables mediaPlayback (server-controllable type)", () => {
    const resolved = resolveEffectiveAutocaptureConfig(undefined, false, {
      v: 1,
      autocapture: { enabled: true, types: { mediaPlayback: true } },
    });
    expect(resolved!.mediaPlayback).toBe(true);
  });

  it("snippet master ON overrides a server that says OFF", () => {
    const resolved = resolveEffectiveAutocaptureConfig(true, false, {
      v: 1,
      autocapture: { enabled: false },
    });
    expect(resolved).not.toBeNull();
    expect(typesOnly(resolved)).toEqual(AUTOCAPTURE_DEFAULTS);
  });

  it("snippet master OFF overrides a server that says ON (fail-safe to null)", () => {
    expect(
      resolveEffectiveAutocaptureConfig(
        false,
        false,
        serverOn({ outboundLinks: true })
      )
    ).toBeNull();
  });

  it("snippet per-key wins over server per-key, both directions", () => {
    const resolved = resolveEffectiveAutocaptureConfig(
      // snippet enables forms (off) and downloads (on) explicitly.
      { formSubmissions: false, fileDownloads: true },
      false,
      serverOn({ formSubmissions: true, fileDownloads: false, outboundLinks: true })
    );
    expect(resolved).not.toBeNull();
    // Snippet wins for the keys it sets...
    expect(resolved!.formSubmissions).toBe(false);
    expect(resolved!.fileDownloads).toBe(true);
    // ...server wins for server-controllable keys the snippet is silent on...
    expect(resolved!.outboundLinks).toBe(true);
    // ...default for keys neither sets (clicks is snippet-only).
    expect(resolved!.clicks).toBe(false);
    expect(resolved!.inputChanges).toBe(false);
  });

  it("server value is used when the snippet is silent on a server-controlled key", () => {
    const resolved = resolveEffectiveAutocaptureConfig(
      { clicks: true }, // snippet only speaks to clicks (also enables)
      false,
      serverOn({ outboundLinks: false, formSubmissions: false })
    );
    expect(resolved!.clicks).toBe(true); // snippet
    expect(resolved!.outboundLinks).toBe(false); // server
    expect(resolved!.formSubmissions).toBe(false); // server
    expect(resolved!.fileDownloads).toBe(true); // default
  });

  it("ignores server values for snippet-only keys (clicks/inputChanges)", () => {
    // The server config has no authority over clicks/inputChanges — those are
    // snippet-only. A server type set for them is ignored; defaults apply.
    const resolved = resolveEffectiveAutocaptureConfig(
      undefined,
      false,
      serverOn({ clicks: true, inputChanges: true } as any)
    );
    expect(resolved!.clicks).toBe(false); // default (server ignored)
    expect(resolved!.inputChanges).toBe(false); // default (server ignored)
  });

  it("built-in default is used when neither snippet nor server sets a key", () => {
    const resolved = resolveEffectiveAutocaptureConfig(
      true,
      false,
      serverOn({})
    );
    expect(typesOnly(resolved)).toEqual(AUTOCAPTURE_DEFAULTS);
  });

  it("legacy enableAutoClicks enables and forces clicks on", () => {
    const resolved = resolveEffectiveAutocaptureConfig(undefined, true, null);
    expect(resolved).not.toBeNull();
    expect(resolved!.clicks).toBe(true);
  });

  it("ignores reserved/unknown server type keys (notFound/spaPageviews)", () => {
    const resolved = resolveEffectiveAutocaptureConfig(undefined, false, {
      v: 1,
      autocapture: {
        enabled: true,
        // notFound is reserved/deferred; spaPageviews no longer exists (SPA is
        // core). Both must be ignored.
        types: { notFound: true, spaPageviews: true } as any,
      },
    });
    // Resolves to the per-type defaults with only known keys.
    expect(typesOnly(resolved)).toEqual(AUTOCAPTURE_DEFAULTS);
    expect(resolved).not.toHaveProperty("notFound");
    expect(resolved).not.toHaveProperty("spaPageviews");
  });

  it("downloadExtensions: defaults to the built-in list when server omits them", () => {
    const resolved = resolveEffectiveAutocaptureConfig(true, false, null);
    expect(resolved!.downloadExtensions).toBe(DOWNLOAD_EXTENSIONS);
  });

  it("downloadExtensions: uses the server list (normalized) when provided", () => {
    const resolved = resolveEffectiveAutocaptureConfig(undefined, false, {
      v: 1,
      autocapture: {
        enabled: true,
        downloads: { extensions: [".PDF", "ZIP", " Csv "] },
      },
    });
    // Lowercased + leading-dot-stripped + trimmed.
    expect(resolved!.downloadExtensions).toEqual(["pdf", "zip", "csv"]);
  });

  it("downloadExtensions: falls back to the default for an empty server list", () => {
    const resolved = resolveEffectiveAutocaptureConfig(undefined, false, {
      v: 1,
      autocapture: { enabled: true, downloads: { extensions: [] } },
    });
    expect(resolved!.downloadExtensions).toBe(DOWNLOAD_EXTENSIONS);
  });

  it("master-vs-type (H-1): a server-OFF + snippet per-type-only stays OFF", () => {
    // Snippet shape with only a per-type override (master undefined) must NOT
    // enable autocapture when the server/dashboard says OFF.
    expect(
      resolveEffectiveAutocaptureConfig(
        { types: { formSubmissions: false } },
        false,
        { v: 1, autocapture: { enabled: false } }
      )
    ).toBeNull();
    // And with no server config at all → still OFF (fail-safe).
    expect(
      resolveEffectiveAutocaptureConfig(
        { types: { outboundLinks: true } },
        false,
        null
      )
    ).toBeNull();
  });

  it("master-vs-type (H-1): snippet master ON enables; per-type still applies", () => {
    const resolved = resolveEffectiveAutocaptureConfig(
      { master: true, types: { formSubmissions: false } },
      false,
      null
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.formSubmissions).toBe(false); // snippet per-type
    expect(resolved!.outboundLinks).toBe(true); // default
  });

  it("master-vs-type (H-1): per-type-only overrides the type when server enables", () => {
    // Server enables autocapture (the master); a bare snippet per-type attr
    // then overrides that one type without having flipped the master itself.
    const resolved = resolveEffectiveAutocaptureConfig(
      { types: { formSubmissions: false } },
      false,
      serverOn({ formSubmissions: true })
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.formSubmissions).toBe(false); // snippet wins over server
    expect(resolved!.outboundLinks).toBe(true); // default
  });

  it("master-vs-type (H-1): snippet master OFF wins even with per-type set", () => {
    expect(
      resolveEffectiveAutocaptureConfig(
        { master: false, types: { outboundLinks: true } },
        false,
        serverOn({ outboundLinks: true })
      )
    ).toBeNull();
  });
});

describe("@logspot/web - autocapture (integration)", () => {
  let fetchMock: ReturnType<typeof setupFetchMock>;

  beforeEach(() => {
    resetCookies();
    window.localStorage.clear();
    __resetInMemoryAnonymousIdForTests();
    document.body.innerHTML = "";
    fetchMock = setupFetchMock();
  });

  afterEach(() => {
    // Detach autocapture listeners between tests so handlers don't leak.
    logspot.reset();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("default config (autocapture unset) emits nothing extra on interaction", async () => {
    await init();
    fetchMock.mockClear();

    document.body.innerHTML = `
      <a id="ext" href="https://external.example/page">External</a>
      <form id="f"><input name="email" /><button type="submit">Go</button></form>
    `;
    click(document.getElementById("ext")!);
    submit(document.getElementById("f") as HTMLFormElement);

    expect(trackBodies(fetchMock)).toHaveLength(0);
  });

  it("outbound links: fires only for external hosts", async () => {
    await init({ autocapture: true });
    fetchMock.mockClear();

    document.body.innerHTML = `
      <a id="internal" href="/dashboard">Internal</a>
      <a id="external" href="https://external.example/pricing">See pricing</a>
    `;

    click(document.getElementById("internal")!);
    expect(trackBodies(fetchMock)).toHaveLength(0);

    click(document.getElementById("external")!);
    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("Outbound Link");
    expect(event?.metadata.href).toBe("https://external.example/pricing");
    expect(event?.metadata.text).toBe("See pricing");
  });

  it("outbound links: skips mailto/tel and same-page anchors", async () => {
    await init({ autocapture: true });
    fetchMock.mockClear();

    document.body.innerHTML = `
      <a id="mail" href="mailto:hi@example.com">Email</a>
      <a id="tel" href="tel:+15551234">Call</a>
      <a id="hash" href="#section">Jump</a>
    `;
    click(document.getElementById("mail")!);
    click(document.getElementById("tel")!);
    click(document.getElementById("hash")!);

    expect(trackBodies(fetchMock)).toHaveLength(0);
  });

  it("outbound links: captures when a nested child inside the anchor is clicked", async () => {
    await init({ autocapture: true });
    fetchMock.mockClear();

    document.body.innerHTML = `
      <a id="external" href="https://external.example/go"><span id="child">Go</span></a>
    `;
    click(document.getElementById("child")!);

    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("Outbound Link");
    expect(event?.metadata.href).toBe("https://external.example/go");
  });

  it("form submissions: fires without field values", async () => {
    await init({ autocapture: true });
    fetchMock.mockClear();

    document.body.innerHTML = `
      <form id="signup" name="signup" action="/submit">
        <input name="email" value="secret@example.com" />
        <input name="password" type="password" value="hunter2" />
        <button type="submit">Sign up</button>
      </form>
    `;
    submit(document.getElementById("signup") as HTMLFormElement);

    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("Form Submitted");
    expect(event?.metadata.id).toBe("signup");
    expect(event?.metadata.name).toBe("signup");
    expect(event?.metadata.action).toContain("/submit");
    // No field values anywhere in the payload.
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("secret@example.com");
    expect(serialized).not.toContain("hunter2");
  });

  it("downloads: fires File Downloaded for a known extension with metadata", async () => {
    await init({ autocapture: true });
    fetchMock.mockClear();

    document.body.innerHTML = `
      <a id="dl" href="https://cdn.example.com/files/report.pdf">Report</a>
    `;
    click(document.getElementById("dl")!);

    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("File Downloaded");
    expect(event?.metadata.href).toBe("https://cdn.example.com/files/report.pdf");
    expect(event?.metadata.fileName).toBe("report.pdf");
    expect(event?.metadata.fileExtension).toBe("pdf");
  });

  it("downloads: fires for an anchor with a download attribute (no known extension)", async () => {
    await init({ autocapture: true });
    fetchMock.mockClear();

    document.body.innerHTML = `
      <a id="dl" href="/generate/export" download>Export</a>
    `;
    click(document.getElementById("dl")!);

    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("File Downloaded");
    expect(event?.metadata.fileName).toBe("export");
    // No dotted extension → fileExtension is undefined (omitted from the wire).
    expect(event?.metadata.fileExtension).toBeUndefined();
  });

  it("downloads: normalizes uppercase extensions and decodes the file name", async () => {
    await init({ autocapture: true });
    fetchMock.mockClear();

    document.body.innerHTML = `
      <a id="dl" href="/docs/Q3%20Report.XLSX">Q3</a>
    `;
    click(document.getElementById("dl")!);

    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("File Downloaded");
    expect(event?.metadata.fileName).toBe("Q3 Report.XLSX");
    expect(event?.metadata.fileExtension).toBe("xlsx");
  });

  it("downloads: a download file on an external host is captured as a download, not outbound", async () => {
    await init({ autocapture: true });
    fetchMock.mockClear();

    document.body.innerHTML = `
      <a id="dl" href="https://external.example/whitepaper.pdf">Whitepaper</a>
    `;
    click(document.getElementById("dl")!);

    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("File Downloaded");
    expect(event?.metadata.fileExtension).toBe("pdf");
  });

  it("downloads: non-download anchors are ignored by the download handler", async () => {
    // outboundLinks off so only the download handler could fire here.
    await init({ autocapture: { outboundLinks: false, formSubmissions: false } });
    fetchMock.mockClear();

    document.body.innerHTML = `
      <a id="page" href="/pricing">Pricing</a>
      <a id="img" href="/assets/logo.png">Logo</a>
      <a id="ext" href="https://external.example/page">External</a>
    `;
    click(document.getElementById("page")!);
    click(document.getElementById("img")!);
    click(document.getElementById("ext")!);

    // .png is not in the extension list and none carry a download attr.
    expect(trackBodies(fetchMock)).toHaveLength(0);
  });

  it("downloads: respects the per-type toggle (fileDownloads:false disables it)", async () => {
    await init({ autocapture: { fileDownloads: false } });
    fetchMock.mockClear();

    document.body.innerHTML = `
      <a id="dl" href="/files/report.pdf">Report</a>
    `;
    click(document.getElementById("dl")!);

    expect(trackBodies(fetchMock)).toHaveLength(0);
  });

  it("downloads: sensitive skip rules for forms/inputs are unaffected", async () => {
    // Downloads + inputChanges on; a sensitive input change is still skipped,
    // and a download still fires — the two paths don't interfere.
    await init({ autocapture: { inputChanges: true } });
    fetchMock.mockClear();

    document.body.innerHTML = `
      <input id="pw" name="password" type="password" value="hunter2" />
      <a id="dl" href="/files/data.csv">Data</a>
    `;
    change(document.getElementById("pw")!);
    expect(trackBodies(fetchMock)).toHaveLength(0);

    click(document.getElementById("dl")!);
    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("File Downloaded");
    expect(event?.metadata.fileExtension).toBe("csv");
    // The password value never appears anywhere.
    expect(JSON.stringify(trackBodies(fetchMock))).not.toContain("hunter2");
  });

  it("clicks: OFF by default (autocapture: true) — bare button click emits nothing", async () => {
    await init({ autocapture: true });
    fetchMock.mockClear();

    document.body.innerHTML = `<button id="btn">Press me</button>`;
    click(document.getElementById("btn")!);

    expect(trackBodies(fetchMock)).toHaveLength(0);
  });

  it("clicks: ON when explicitly enabled — fires Click with tag/id/text", async () => {
    await init({ autocapture: { clicks: true } });
    fetchMock.mockClear();

    document.body.innerHTML = `<button id="cta">Buy <span>now</span></button>`;
    click(document.getElementById("cta")!);

    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("Click");
    expect(event?.metadata.tag).toBe("BUTTON");
    expect(event?.metadata.id).toBe("cta");
    expect(event?.metadata.text).toBe("Buy now");
  });

  it("clicks: skips elements whose text exceeds the length guard (uses .length)", async () => {
    await init({ autocapture: { clicks: true } });
    fetchMock.mockClear();

    const longText = "x".repeat(501);
    document.body.innerHTML = `<button id="long">${longText}</button>`;
    click(document.getElementById("long")!);

    expect(trackBodies(fetchMock)).toHaveLength(0);
  });

  it("input changes: skips password and never includes the value", async () => {
    await init({ autocapture: { inputChanges: true } });
    fetchMock.mockClear();

    document.body.innerHTML = `
      <input id="email" name="email" type="email" value="user@example.com" />
      <input id="pw" name="password" type="password" value="hunter2" />
    `;

    change(document.getElementById("pw")!);
    expect(trackBodies(fetchMock)).toHaveLength(0);

    change(document.getElementById("email")!);
    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("Input Changed");
    expect(event?.metadata.name).toBe("email");
    expect(event?.metadata.type).toBe("email");
    expect(JSON.stringify(event)).not.toContain("user@example.com");
  });

  it("input changes: skips sensitive autocomplete + data-lgspt-sensitive", async () => {
    await init({ autocapture: { inputChanges: true } });
    fetchMock.mockClear();

    document.body.innerHTML = `
      <input id="otp" name="otp" autocomplete="one-time-code" />
      <input id="cc" name="card" autocomplete="cc-number" />
      <input id="curpw" name="cur" autocomplete="current-password" />
      <input id="flagged" name="ssn" data-lgspt-sensitive />
    `;
    for (const id of ["otp", "cc", "curpw", "flagged"]) {
      change(document.getElementById(id)!);
    }

    expect(trackBodies(fetchMock)).toHaveLength(0);
  });

  it("declarative: data-lgspt-event fires the named event with props", async () => {
    await init({ autocapture: true });
    fetchMock.mockClear();

    document.body.innerHTML = `
      <button id="cta" data-lgspt-event="Upgrade Clicked"
              data-lgspt-prop-plan="pro" data-lgspt-prop-source="hero">
        Upgrade
      </button>
    `;
    click(document.getElementById("cta")!);

    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("Upgrade Clicked");
    expect(event?.metadata.plan).toBe("pro");
    expect(event?.metadata.source).toBe("hero");
  });

  it("declarative: matches the closest ancestor carrying the attribute", async () => {
    await init({ autocapture: true });
    fetchMock.mockClear();

    document.body.innerHTML = `
      <div data-lgspt-event="Card Clicked" data-lgspt-prop-id="42">
        <span id="inner">Open</span>
      </div>
    `;
    click(document.getElementById("inner")!);

    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("Card Clicked");
    expect(event?.metadata.id).toBe("42");
  });

  it("enableAutoClicks back-compat: maps to clicks and captures Click", async () => {
    await init({ enableAutoClicks: true });
    fetchMock.mockClear();

    document.body.innerHTML = `<button id="legacy">Legacy</button>`;
    click(document.getElementById("legacy")!);

    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("Click");
    expect(event?.metadata.tag).toBe("BUTTON");
  });
});

describe("@logspot/web - autocapture privacy regressions", () => {
  let fetchMock: ReturnType<typeof setupFetchMock>;

  beforeEach(() => {
    resetCookies();
    window.localStorage.clear();
    __resetInMemoryAnonymousIdForTests();
    document.body.innerHTML = "";
    fetchMock = setupFetchMock();
  });

  afterEach(() => {
    logspot.reset();
    document.body.innerHTML = "";
    window.history.replaceState({}, "", "/");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("action-less forms do not leak the page URL through metadata.action", async () => {
    await init({ autocapture: true });
    window.history.replaceState({}, "", "/checkout?token=SECRET123");
    fetchMock.mockClear();

    document.body.innerHTML = `<form id="bare"><button type="submit">Go</button></form>`;
    submit(document.getElementById("bare") as HTMLFormElement);

    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("Form Submitted");
    expect(event?.metadata.action).toBeUndefined();
  });

  it("strips query/hash from an explicit form action", async () => {
    await init({ autocapture: true });
    fetchMock.mockClear();

    document.body.innerHTML = `<form id="q" action="/submit?token=SECRET123#frag"><button type="submit">Go</button></form>`;
    submit(document.getElementById("q") as HTMLFormElement);

    const event = onlyEvent(fetchMock);
    expect(event?.metadata.action).toContain("/submit");
    expect(String(event?.metadata.action)).not.toContain("SECRET123");
  });

  it("never captures clicks inside a data-lgspt-sensitive subtree", async () => {
    await init({ autocapture: { clicks: true } });
    fetchMock.mockClear();

    document.body.innerHTML = `
      <div data-lgspt-sensitive>
        <button id="secret-btn">Account number 12345678</button>
      </div>
    `;
    click(document.getElementById("secret-btn")!);

    expect(trackBodies(fetchMock)).toHaveLength(0);
  });

  it("does not capture form-control text on generic clicks", async () => {
    await init({ autocapture: { clicks: true } });
    fetchMock.mockClear();

    document.body.innerHTML = `<textarea id="ta">prefilled private text</textarea>`;
    click(document.getElementById("ta")!);

    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("Click");
    expect(event?.metadata.text).toBeUndefined();
  });

  it("captures middle-click (auxclick) outbound opens", async () => {
    await init({ autocapture: true });
    fetchMock.mockClear();

    document.body.innerHTML = `<a id="out" href="https://external.example/go">Ext</a>`;
    document.getElementById("out")!.dispatchEvent(
      new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 })
    );

    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("Outbound Link");
    expect(event?.metadata.href).toBe("https://external.example/go");
  });
});

describe("@logspot/web - autocapture mediaPlayback (integration)", () => {
  let fetchMock: ReturnType<typeof setupFetchMock>;

  beforeEach(() => {
    resetCookies();
    window.localStorage.clear();
    __resetInMemoryAnonymousIdForTests();
    document.body.innerHTML = "";
    fetchMock = setupFetchMock();
  });

  afterEach(() => {
    logspot.reset();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("play emits Media Played with media_type/src/title/duration metadata", async () => {
    await init({ autocapture: { mediaPlayback: true } });
    fetchMock.mockClear();

    document.body.innerHTML = `<video id="hero"></video>`;
    const video = document.getElementById("hero") as HTMLVideoElement;
    stubMedia(video, {
      duration: 120,
      currentTime: 0,
      currentSrc: "https://cdn.example.com/clips/promo.mp4?token=secret",
    });

    fireMedia(video, "play");

    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("Media Played");
    expect(event?.metadata.media_type).toBe("video");
    // id wins over the source for `src`.
    expect(event?.metadata.src).toBe("hero");
    expect(event?.metadata.duration).toBe("120");
    expect(event?.metadata.current_time).toBe("0");
    // The query string (with its token) never appears anywhere.
    expect(JSON.stringify(event)).not.toContain("secret");
  });

  it("src falls back to the currentSrc basename (no id), dropping the query", async () => {
    await init({ autocapture: { mediaPlayback: true } });
    fetchMock.mockClear();

    document.body.innerHTML = `<audio aria-label="Episode 5"></audio>`;
    const audio = document.querySelector("audio") as HTMLAudioElement;
    stubMedia(audio, {
      duration: 60,
      currentTime: 0,
      currentSrc: "https://cdn.example.com/audio/ep5.mp3?sig=abc123",
    });

    fireMedia(audio, "play");

    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("Media Played");
    expect(event?.metadata.media_type).toBe("audio");
    expect(event?.metadata.src).toBe("ep5.mp3");
    expect(event?.metadata.title).toBe("Episode 5");
    expect(JSON.stringify(event)).not.toContain("abc123");
  });

  it("crossing 25/50/75% emits one Media Progress each (and not twice)", async () => {
    await init({ autocapture: { mediaPlayback: true } });
    fetchMock.mockClear();

    document.body.innerHTML = `<video id="v"></video>`;
    const video = document.getElementById("v") as HTMLVideoElement;
    let currentTime = 0;
    Object.defineProperty(video, "duration", {
      configurable: true,
      get: () => 100,
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTime,
    });

    // Below the first threshold → nothing.
    currentTime = 10;
    fireMedia(video, "timeupdate");
    expect(trackBodies(fetchMock)).toHaveLength(0);

    // Cross 25%.
    currentTime = 26;
    fireMedia(video, "timeupdate");
    // A second update still within 25–50% must NOT re-fire 25%.
    currentTime = 40;
    fireMedia(video, "timeupdate");

    // Cross 50% and 75%.
    currentTime = 55;
    fireMedia(video, "timeupdate");
    currentTime = 80;
    fireMedia(video, "timeupdate");

    const events = trackBodies(fetchMock);
    expect(events.map((e) => e.name)).toEqual([
      "Media Progress",
      "Media Progress",
      "Media Progress",
    ]);
    expect(events.map((e) => e.metadata.percent)).toEqual(["25", "50", "75"]);
  });

  it("a single timeupdate past 75% emits all three milestones once", async () => {
    await init({ autocapture: { mediaPlayback: true } });
    fetchMock.mockClear();

    document.body.innerHTML = `<video id="v"></video>`;
    const video = document.getElementById("v") as HTMLVideoElement;
    stubMedia(video, { duration: 100, currentTime: 90 });

    fireMedia(video, "timeupdate");

    const events = trackBodies(fetchMock);
    expect(events.map((e) => e.metadata.percent)).toEqual(["25", "50", "75"]);
    // A subsequent update at the same point re-fires nothing.
    fireMedia(video, "timeupdate");
    expect(trackBodies(fetchMock)).toHaveLength(3);
  });

  it("ended emits Media Completed with percent 100", async () => {
    await init({ autocapture: { mediaPlayback: true } });
    fetchMock.mockClear();

    document.body.innerHTML = `<video id="v" title="Demo"></video>`;
    const video = document.getElementById("v") as HTMLVideoElement;
    stubMedia(video, { duration: 100, currentTime: 100 });

    fireMedia(video, "ended");

    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("Media Completed");
    expect(event?.metadata.percent).toBe("100");
    expect(event?.metadata.title).toBe("Demo");
    expect(event?.metadata.current_time).toBe("100");
  });

  it("pause emits Media Paused, but not the natural pause at end (ended)", async () => {
    await init({ autocapture: { mediaPlayback: true } });
    fetchMock.mockClear();

    document.body.innerHTML = `<video id="v"></video>`;
    const video = document.getElementById("v") as HTMLVideoElement;
    let ended = false;
    stubMedia(video, { duration: 100, currentTime: 50 });
    Object.defineProperty(video, "ended", {
      configurable: true,
      get: () => ended,
    });

    // A mid-playback pause fires.
    fireMedia(video, "pause");
    expect(onlyEvent(fetchMock)?.name).toBe("Media Paused");

    // The natural end-of-media pause (ended === true) is skipped.
    fetchMock.mockClear();
    ended = true;
    fireMedia(video, "pause");
    expect(trackBodies(fetchMock)).toHaveLength(0);
  });

  it("progress milestones reset after ended so a replay re-fires them", async () => {
    await init({ autocapture: { mediaPlayback: true } });
    fetchMock.mockClear();

    document.body.innerHTML = `<video id="v"></video>`;
    const video = document.getElementById("v") as HTMLVideoElement;
    let currentTime = 80;
    Object.defineProperty(video, "duration", {
      configurable: true,
      get: () => 100,
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTime,
    });

    fireMedia(video, "timeupdate"); // 25/50/75
    fireMedia(video, "ended"); // completes + resets milestones
    fetchMock.mockClear();

    // Replay from the start, then cross 25% again.
    currentTime = 0;
    fireMedia(video, "timeupdate");
    currentTime = 30;
    fireMedia(video, "timeupdate");

    const events = trackBodies(fetchMock);
    expect(events.map((e) => e.metadata.percent)).toEqual(["25"]);
  });

  it("duration is omitted for a live stream (non-finite duration)", async () => {
    await init({ autocapture: { mediaPlayback: true } });
    fetchMock.mockClear();

    document.body.innerHTML = `<video id="live"></video>`;
    const video = document.getElementById("live") as HTMLVideoElement;
    stubMedia(video, { duration: Infinity, currentTime: 42 });

    fireMedia(video, "play");

    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("Media Played");
    expect(event?.metadata.duration).toBeUndefined();
    expect(event?.metadata.current_time).toBe("42");

    // A live stream has no finite duration, so no progress milestones fire.
    fetchMock.mockClear();
    fireMedia(video, "timeupdate");
    expect(trackBodies(fetchMock)).toHaveLength(0);
  });

  it("title falls back to a figcaption inside an ancestor figure", async () => {
    await init({ autocapture: { mediaPlayback: true } });
    fetchMock.mockClear();

    document.body.innerHTML = `
      <figure>
        <video id="v"></video>
        <figcaption>Onboarding walkthrough</figcaption>
      </figure>
    `;
    const video = document.getElementById("v") as HTMLVideoElement;
    stubMedia(video, { duration: 30, currentTime: 0 });

    fireMedia(video, "play");

    const event = onlyEvent(fetchMock);
    expect(event?.metadata.title).toBe("Onboarding walkthrough");
  });

  it("skips a media element flagged data-lgspt-sensitive", async () => {
    await init({ autocapture: { mediaPlayback: true } });
    fetchMock.mockClear();

    document.body.innerHTML = `
      <div data-lgspt-sensitive>
        <video id="private"></video>
      </div>
    `;
    const video = document.getElementById("private") as HTMLVideoElement;
    stubMedia(video, { duration: 100, currentTime: 80 });

    fireMedia(video, "play");
    fireMedia(video, "timeupdate");
    fireMedia(video, "ended");

    expect(trackBodies(fetchMock)).toHaveLength(0);
  });

  it("mediaPlayback: false (autocapture on) emits nothing on media events", async () => {
    await init({ autocapture: true });
    fetchMock.mockClear();

    document.body.innerHTML = `<video id="v"></video>`;
    const video = document.getElementById("v") as HTMLVideoElement;
    stubMedia(video, { duration: 100, currentTime: 80 });

    fireMedia(video, "play");
    fireMedia(video, "timeupdate");
    fireMedia(video, "ended");

    expect(trackBodies(fetchMock)).toHaveLength(0);
  });

  it("master OFF: media events emit nothing even with mediaPlayback set", async () => {
    await init({ autocapture: { master: false, types: { mediaPlayback: true } } });
    fetchMock.mockClear();

    document.body.innerHTML = `<video id="v"></video>`;
    const video = document.getElementById("v") as HTMLVideoElement;
    stubMedia(video, { duration: 100, currentTime: 80 });

    fireMedia(video, "play");
    fireMedia(video, "ended");

    expect(trackBodies(fetchMock)).toHaveLength(0);
  });

  it("non-media element targets are ignored by the media listeners", async () => {
    await init({ autocapture: { mediaPlayback: true } });
    fetchMock.mockClear();

    document.body.innerHTML = `<div id="notmedia"></div>`;
    const div = document.getElementById("notmedia")!;
    // A stray non-bubbling event on a non-media element must be ignored.
    div.dispatchEvent(new Event("play", { bubbles: false }));
    div.dispatchEvent(new Event("ended", { bubbles: false }));

    expect(trackBodies(fetchMock)).toHaveLength(0);
  });
});

describe("@logspot/web - autocapture from server config (integration)", () => {
  let fetchMock: ReturnType<typeof setupFetchMock>;

  beforeEach(() => {
    resetCookies();
    window.localStorage.clear();
    __resetInMemoryAnonymousIdForTests();
    document.body.innerHTML = "";
    fetchMock = setupFetchMock();
  });

  afterEach(() => {
    logspot.reset();
    clearRemoteConfig(PUBLIC_KEY);
    document.body.innerHTML = "";
    window.localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("applies cached server config on init (no snippet)", async () => {
    writeRemoteConfig(PUBLIC_KEY, {
      v: 1,
      autocapture: { enabled: true, types: { outboundLinks: true } },
    });

    await init(); // no `autocapture` option
    fetchMock.mockClear();

    document.body.innerHTML = `<a id="ext" href="https://external.example/x">Go</a>`;
    click(document.getElementById("ext")!);

    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("Outbound Link");
  });

  it("server can enable mediaPlayback (no snippet)", async () => {
    writeRemoteConfig(PUBLIC_KEY, {
      v: 1,
      autocapture: { enabled: true, types: { mediaPlayback: true } },
    });
    await init(); // no `autocapture` option
    fetchMock.mockClear();

    document.body.innerHTML = `<video id="hero"></video>`;
    const video = document.getElementById("hero") as HTMLVideoElement;
    stubMedia(video, { duration: 30, currentTime: 0 });
    fireMedia(video, "play");

    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("Media Played");
    expect(event?.metadata.src).toBe("hero");
  });

  it("fail-safe OFF: no config + no snippet → nothing captured", async () => {
    await init(); // no snippet, no cached config
    fetchMock.mockClear();

    document.body.innerHTML = `
      <a id="ext" href="https://external.example/x">Go</a>
      <a id="dl" href="/files/report.pdf">PDF</a>
    `;
    click(document.getElementById("ext")!);
    click(document.getElementById("dl")!);

    expect(trackBodies(fetchMock)).toHaveLength(0);
  });

  it("fail-safe OFF: server says disabled → nothing captured", async () => {
    writeRemoteConfig(PUBLIC_KEY, {
      v: 1,
      autocapture: { enabled: false },
    });
    await init();
    fetchMock.mockClear();

    document.body.innerHTML = `<a id="ext" href="https://external.example/x">Go</a>`;
    click(document.getElementById("ext")!);

    expect(trackBodies(fetchMock)).toHaveLength(0);
  });

  it("snippet master OFF wins over a server that enables", async () => {
    writeRemoteConfig(PUBLIC_KEY, {
      v: 1,
      autocapture: { enabled: true, types: { outboundLinks: true } },
    });
    await init({ autocapture: false });
    fetchMock.mockClear();

    document.body.innerHTML = `<a id="ext" href="https://external.example/x">Go</a>`;
    click(document.getElementById("ext")!);

    expect(trackBodies(fetchMock)).toHaveLength(0);
  });

  it("snippet per-type OFF wins over server ON for that key", async () => {
    writeRemoteConfig(PUBLIC_KEY, {
      v: 1,
      autocapture: { enabled: true, types: { formSubmissions: true } },
    });
    // Snippet enables autocapture but force-disables forms.
    await init({ autocapture: { formSubmissions: false } });
    fetchMock.mockClear();

    document.body.innerHTML = `
      <form id="f" name="f" action="/s"><button type="submit">Go</button></form>
      <a id="ext" href="https://external.example/x">Go</a>
    `;
    submit(document.getElementById("f") as HTMLFormElement);
    // Forms suppressed by the snippet override...
    expect(trackBodies(fetchMock)).toHaveLength(0);

    // ...but outbound (server-silent → default ON) still fires.
    click(document.getElementById("ext")!);
    expect(onlyEvent(fetchMock)?.name).toBe("Outbound Link");
  });

  it("re-applies when fresh server config arrives on a track response", async () => {
    // Start with autocapture off (no snippet, no cache).
    await init();

    // The server now returns config enabling outbound capture on the next event.
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          config: {
            v: 1,
            autocapture: { enabled: true, types: { outboundLinks: true } },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    // Fire any event to receive + persist the config (re-applies autocapture).
    await logspot.track({ event: "Ping" });
    fetchMock.mockClear();

    // Now an outbound click should be captured.
    document.body.innerHTML = `<a id="ext" href="https://external.example/x">Go</a>`;
    click(document.getElementById("ext")!);

    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("Outbound Link");
  });

  it("the legacy lgspt- classname click is captured automatically (restored)", async () => {
    // The always-on legacy listener is restored: a bare `lgspt-` class fires an
    // event named after the class, even though no data-lgspt-event is present.
    await init({ autocapture: true });
    fetchMock.mockClear();

    document.body.innerHTML = `<div id="legacy" class="lgspt-imagine-cta">CTA</div>`;
    click(document.getElementById("legacy")!);

    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("Imagine Cta");
  });

  it("the legacy lgspt- classname click fires even when autocapture is OFF (H-4)", async () => {
    // No snippet, no server config → autocapture resolves OFF. The legacy
    // class-click listener is independent of autocapture and must still fire.
    await init();
    fetchMock.mockClear();

    document.body.innerHTML = `<div id="legacy" class="lgspt-pricing-cta">CTA</div>`;
    click(document.getElementById("legacy")!);

    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("Pricing Cta");
  });

  it("downloads: honors the server-provided extensions list (H-2a)", async () => {
    // Server enables downloads and supplies a custom extension list (with mixed
    // case + a leading dot) that does NOT include the built-in defaults.
    writeRemoteConfig(PUBLIC_KEY, {
      v: 1,
      autocapture: {
        enabled: true,
        downloads: { extensions: [".DMG2", "Foo"] },
      },
    });
    await init();
    fetchMock.mockClear();

    document.body.innerHTML = `
      <a id="custom" href="/files/installer.dmg2">Installer</a>
      <a id="builtin" href="/files/report.pdf">Report</a>
    `;
    // A custom server extension is matched (normalized).
    click(document.getElementById("custom")!);
    let event = onlyEvent(fetchMock);
    expect(event?.name).toBe("File Downloaded");
    expect(event?.metadata.fileExtension).toBe("dmg2");

    // A built-in default extension is NOT matched once the server overrides the
    // list (the server list replaces, not augments).
    fetchMock.mockClear();
    click(document.getElementById("builtin")!);
    expect(trackBodies(fetchMock)).toHaveLength(0);
  });

  it("downloads: empty server extensions fall back to the built-in defaults", async () => {
    writeRemoteConfig(PUBLIC_KEY, {
      v: 1,
      autocapture: { enabled: true, downloads: { extensions: [] } },
    });
    await init();
    fetchMock.mockClear();

    document.body.innerHTML = `<a id="dl" href="/files/report.pdf">Report</a>`;
    click(document.getElementById("dl")!);

    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("File Downloaded");
    expect(event?.metadata.fileExtension).toBe("pdf");
  });

  it("H-1: snippet per-type-only ({ types }) does NOT enable when server is OFF", async () => {
    writeRemoteConfig(PUBLIC_KEY, {
      v: 1,
      autocapture: { enabled: false },
    });
    // Bare per-type snippet (master undefined) must not flip autocapture on.
    await init({ autocapture: { types: { formSubmissions: true } } });
    fetchMock.mockClear();

    document.body.innerHTML = `
      <form id="f" name="f" action="/s"><button type="submit">Go</button></form>
      <a id="ext" href="https://external.example/x">Go</a>
    `;
    submit(document.getElementById("f") as HTMLFormElement);
    click(document.getElementById("ext")!);

    // Autocapture stayed OFF, so nothing is captured.
    expect(trackBodies(fetchMock)).toHaveLength(0);
  });

  it("H-1: snippet per-type-only overrides the type when the server enables", async () => {
    writeRemoteConfig(PUBLIC_KEY, {
      v: 1,
      autocapture: { enabled: true, types: { formSubmissions: true } },
    });
    // Server enables (master); a bare per-type snippet then disables forms only.
    await init({ autocapture: { types: { formSubmissions: false } } });
    fetchMock.mockClear();

    document.body.innerHTML = `
      <form id="f" name="f" action="/s"><button type="submit">Go</button></form>
      <a id="ext" href="https://external.example/x">Go</a>
    `;
    submit(document.getElementById("f") as HTMLFormElement);
    expect(trackBodies(fetchMock)).toHaveLength(0); // forms overridden off

    click(document.getElementById("ext")!);
    expect(onlyEvent(fetchMock)?.name).toBe("Outbound Link"); // default ON
  });

  it("H-1: snippet { master: true } enables even when the server is OFF", async () => {
    writeRemoteConfig(PUBLIC_KEY, {
      v: 1,
      autocapture: { enabled: false },
    });
    await init({ autocapture: { master: true } });
    fetchMock.mockClear();

    document.body.innerHTML = `<a id="ext" href="https://external.example/x">Go</a>`;
    click(document.getElementById("ext")!);

    expect(onlyEvent(fetchMock)?.name).toBe("Outbound Link");
  });

  it("the declarative data-lgspt-event path still works", async () => {
    await init({ autocapture: true });
    fetchMock.mockClear();

    document.body.innerHTML = `
      <button id="cta" data-lgspt-event="Upgrade Clicked" data-lgspt-prop-plan="pro">
        Upgrade
      </button>`;
    click(document.getElementById("cta")!);

    const event = onlyEvent(fetchMock);
    expect(event?.name).toBe("Upgrade Clicked");
    expect(event?.metadata.plan).toBe("pro");
  });
});
