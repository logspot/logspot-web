import { PrivacySignals } from "./consent";

/**
 * Browser privacy-signal detection, kept separate from `dnt.ts` (which retains
 * its kill-switch semantics) and from consent categories.
 *
 * V1 scope:
 *  - GPC via `navigator.globalPrivacyControl`.
 *  - GPP detection via the `window.__gpp` CMP-API stub (`ping` + `addEventListener`).
 *    Only detection + the raw `gppString` are captured; per-section opt-out
 *    parsing is deferred.
 */

type GppPingData = {
  gppString?: string;
  signalStatus?: string;
  cmpStatus?: string;
  [key: string]: unknown;
};

type GppListenerData = {
  pingData?: GppPingData;
  gppString?: string;
  eventName?: string;
  [key: string]: unknown;
};

type GppApi = (
  command: string,
  callback: (data: unknown, success: boolean) => void,
  parameter?: unknown
) => void;

/**
 * Read GPC. Returns `true` only when the browser explicitly exposes the signal
 * as enabled; `undefined` when the API is absent (so callers can distinguish
 * "not present" from "present and false").
 */
export const detectGpc = (): boolean | undefined => {
  try {
    if (typeof navigator === "undefined") return undefined;
    const value = (navigator as Navigator & {
      globalPrivacyControl?: boolean;
    }).globalPrivacyControl;
    if (typeof value === "boolean") {
      return value;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

const getGppApi = (): GppApi | undefined => {
  try {
    if (typeof window === "undefined") return undefined;
    const api = (window as Window & { __gpp?: unknown }).__gpp;
    return typeof api === "function" ? (api as GppApi) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Synchronously probe for GPP via `__gpp('ping', cb)`. The IAB stub invokes the
 * callback synchronously, so the result is available immediately in practice;
 * if a host implementation is async, the synchronous read simply returns
 * "not detected" and a later `subscribeGpp` event updates state.
 */
export const detectGpp = (): { detected: boolean; gppString?: string } => {
  const api = getGppApi();
  if (!api) {
    return { detected: false };
  }

  let detected = false;
  let gppString: string | undefined;

  try {
    api("ping", (data, success) => {
      if (!success || !data || typeof data !== "object") return;
      detected = true;
      const ping = data as GppPingData;
      if (typeof ping.gppString === "string" && ping.gppString.length > 0) {
        gppString = ping.gppString;
      }
    });
  } catch {
    // A present-but-throwing stub still counts as "GPP framework present".
    detected = true;
  }

  return { detected, gppString };
};

/**
 * Subscribe to GPP section/string changes via `__gpp('addEventListener', cb)`.
 * Calls `onChange` whenever the GPP string is (re)computed. Returns an
 * unsubscribe function (best-effort `removeEventListener`).
 */
export const subscribeGpp = (
  onChange: (result: { detected: boolean; gppString?: string }) => void
): (() => void) => {
  const api = getGppApi();
  if (!api) {
    return () => {};
  }

  let listenerId: unknown;

  try {
    api("addEventListener", (data, success) => {
      if (!success || !data || typeof data !== "object") return;
      const event = data as GppListenerData;
      if (typeof event.listenerId !== "undefined") {
        listenerId = event.listenerId;
      }
      const gppString =
        typeof event.pingData?.gppString === "string"
          ? event.pingData.gppString
          : typeof event.gppString === "string"
          ? event.gppString
          : undefined;
      onChange({ detected: true, gppString });
    });
  } catch {
    return () => {};
  }

  return () => {
    try {
      if (typeof listenerId !== "undefined") {
        api("removeEventListener", () => {}, listenerId);
      }
    } catch {
      // ignore
    }
  };
};

/**
 * Detect all currently-readable browser privacy signals as a `PrivacySignals`
 * fragment suitable for merging into a consent snapshot. Only signals that are
 * actually present are included.
 */
export const detectPrivacySignals = (): PrivacySignals => {
  const signals: PrivacySignals = {};

  const gpc = detectGpc();
  if (gpc === true) {
    signals.gpc = true;
  }

  const gpp = detectGpp();
  if (gpp.detected) {
    signals.gppDetected = true;
    if (gpp.gppString) {
      signals.gppString = gpp.gppString;
    }
  }

  return signals;
};
