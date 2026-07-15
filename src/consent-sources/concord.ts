import type {
  ConsentSnapshot,
  ConsentCategory,
  PrivacySignals,
} from "../consent";
import type { ConsentSource } from "./types";
import { listenToWindowEvents } from "./listen";

/**
 * Concord CMP adapter (concord.tech). Read-only. Sits high on the source
 * ladder (`concord`, just below the explicit API).
 *
 * Contract per the public docs:
 * https://www.concord.tech/docs/manually-blocking-trackers-before-consent
 *
 *   window.concord.consent.hasConsent(category: string): boolean
 *     — reads `store.consentState.allowState[category] === true`. Definitive
 *       under Concord's enforcement model: `false` means "not granted (yet)",
 *       which is exactly what Concord itself uses to gate trackers, so we
 *       mirror it verbatim.
 *   window.concord.consent.hasDoNotSell(): boolean
 *     — `allowState.do_not_sell === true`. The adapter reports this signal
 *       FAITHFULLY whenever it is active — signals and categories are
 *       independent facts and the adapter is a reader, not an interpreter.
 *       SEMANTICS NOTE: `marketing: true` +
 *       `do_not_sell: true` almost always means DNS/GPC was detected and
 *       auto-declined marketing, and the user then manually flipped
 *       marketing back on. Either way the CMP result is trusted AS-IS — how
 *       marketing got to true is Concord's business. The resolution happens
 *       DOWNSTREAM in Logspot's export evaluation (a source-reported
 *       `marketing: true` in current consent overrides `doNotSellShare`;
 *       DNS wins only when no source ever spoke for marketing), so both
 *       facts must arrive intact.
 *   window.concord.consent.hasGPC(): boolean
 *     — true when the `global_privacy_control` consent record is accepted
 *       (i.e. Concord detected and applied GPC). Feeds Logspot's `gpc`
 *       signal.
 *   window.concord.consent.isDefaults: boolean (proxy getter)
 *     — true while the state is region-template defaults (no real user
 *       decision yet). Recorded as sourceMetadata so Logspot can tell
 *       default-derived consent from an actual user decision.
 *   window.concord.consent.onConsent(category, cb)
 *     — one-shot grant hook; we rely on the window events below instead,
 *       which also cover revocations.
 *
 *   Window events:
 *     concord-ready                  — fully initialized
 *     concord-consent-state-loading  — fetching consent state (reads unsafe)
 *     concord-consent-state-loaded   — consent state retrieved
 *     concord-consent-state-changed  — user updated preferences
 *     concord-unavailable            — Concord aborted (it also sets
 *                                      window.concord = undefined)
 *
 * Category mapping is IDENTITY: Concord's canonical categories are already
 * `analytics` / `functional` / `marketing` — `hasConsent` is called with our
 * category names directly.
 *
 * The signal helpers (`hasDoNotSell`/`hasGPC`) and `isDefaults` are guarded as
 * optional — older Concord builds that only ship `hasConsent` still work,
 * they just emit categories only.
 */

const SOURCE_NAME = "concord";
const PRIORITY = 80;

const CATEGORIES: ConsentCategory[] = ["analytics", "functional", "marketing"];

type ConcordConsentApi = {
  hasConsent: (category: string) => boolean;
  hasDoNotSell?: () => boolean;
  hasGPC?: () => boolean;
  isDefaults?: boolean;
  onConsent?: (category: string, cb: () => void) => void;
};

const getConcordConsentApi = (): ConcordConsentApi | null => {
  try {
    const win = window as Window & {
      concord?: { consent?: unknown };
    };
    const consent = win.concord?.consent;
    if (
      consent &&
      typeof consent === "object" &&
      typeof (consent as ConcordConsentApi).hasConsent === "function"
    ) {
      return consent as ConcordConsentApi;
    }
    return null;
  } catch {
    return null;
  }
};

// Events that mean consent state is (re)readable.
const STATE_READY_EVENTS = [
  "concord-ready",
  "concord-consent-state-loaded",
  "concord-consent-state-changed",
] as const;

/**
 * Construct the Concord CMP source. `read()` yields `null` until
 * `window.concord.consent` is present (and not mid-load / aborted — see the
 * loading/unavailable guards, which only engage once `subscribe()` has
 * observed the corresponding events).
 */
export const createConcordSource = (): ConsentSource => {
  // Guards observed via events while subscribed. `hasConsent` presence alone
  // makes the API readable (Concord's own docs gate trackers on it directly);
  // the events tighten the window where state is being (re)fetched or Concord
  // gave up entirely.
  let stateLoading = false;
  let unavailable = false;

  return {
    name: SOURCE_NAME,
    priority: PRIORITY,
    read(): ConsentSnapshot | null {
      try {
        if (unavailable || stateLoading) return null;
        const api = getConcordConsentApi();
        if (!api) return null;

        const categories: Partial<Record<ConsentCategory, boolean>> = {};
        for (const category of CATEGORIES) {
          // hasConsent is definitive under Concord's model: false = not
          // granted (yet). Pre-decision "denied" matches Concord's own
          // tracker gating; a later decision fires
          // concord-consent-state-changed and the snapshot updates.
          categories[category] = api.hasConsent(category) === true;
        }

        // Signals are reported faithfully and independently of categories;
        // the marketing-overrides-DNS resolution happens downstream (see
        // header).
        const signals: PrivacySignals = {};
        const sourceMetadata: Record<string, unknown> = {};

        if (typeof api.hasDoNotSell === "function" && api.hasDoNotSell()) {
          signals.doNotSellShare = true;
        }
        if (typeof api.hasGPC === "function" && api.hasGPC() === true) {
          signals.gpc = true;
        }

        if (typeof api.isDefaults === "boolean") {
          sourceMetadata.isDefaults = api.isDefaults;
        }

        const snapshot: ConsentSnapshot = {
          categories,
          signals,
          source: SOURCE_NAME,
          updatedAt: new Date().toISOString(),
        };
        if (Object.keys(sourceMetadata).length > 0) {
          snapshot.sourceMetadata = sourceMetadata;
        }
        return snapshot;
      } catch {
        return null;
      }
    },
    subscribe(cb: () => void): () => void {
      const notify = () => {
        try {
          cb();
        } catch {
          // ignore subscriber errors
        }
      };

      const offReady = listenToWindowEvents(STATE_READY_EVENTS, () => {
        stateLoading = false;
        unavailable = false;
        notify();
      });
      const offLoading = listenToWindowEvents(
        ["concord-consent-state-loading"],
        () => {
          stateLoading = true;
        }
      );
      const offUnavailable = listenToWindowEvents(
        ["concord-unavailable"],
        () => {
          unavailable = true;
        }
      );

      return () => {
        offReady();
        offLoading();
        offUnavailable();
      };
    },
  };
};
