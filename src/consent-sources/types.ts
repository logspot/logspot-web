import type { ConsentSnapshot } from "../consent";

/**
 * Consent-source plugin interface.
 *
 * A consent source is a read-only adapter over a CMP or a privacy framework
 * already running on the page (Concord, OneTrust, Usercentrics, Cookiebot, the
 * Google Consent Mode reader, ...). Each source knows how to:
 *
 *  - `read()` the vendor's *current* consent state as a {@link ConsentSnapshot}
 *    (or `null` when the vendor global is not present / has not produced a
 *    decision yet), and
 *  - `subscribe(cb)` to the vendor's change events so the SDK re-reads whenever
 *    the user updates their choices.
 *
 * Sources never *write* to the vendor (the GCM reader, in particular, must never
 * call `gtag('consent', ...)`). The SDK funnels every snapshot a source produces
 * through `logspot.applyConsentSnapshot`, where the consent store enforces the
 * priority ladder (`logspot_api` > `concord` > 3p CMP > `gcm`). A
 * source therefore does not need to reason about priority itself — it only
 * reports what its vendor says.
 */
export type ConsentSource = {
  /**
   * Stable source identifier; must match a value on the consent-source priority
   * ladder (e.g. `concord`, `onetrust`, `usercentrics`, `cookiebot`,
   * `gcm`). The snapshots this source produces carry the same `source`.
   */
  name: string;

  /**
   * The source's priority on the ladder. Informational on the source itself —
   * the store derives the authoritative priority from `snapshot.source` — but
   * exposed so the registry can order/log sources deterministically.
   */
  priority: number;

  /**
   * Read the vendor's current consent state. Returns `null` when the vendor is
   * not present on the page or has not yet produced a decision; must never
   * throw (vendor globals can be absent, partially loaded, or malformed).
   */
  read(): ConsentSnapshot | null;

  /**
   * Subscribe to the vendor's consent-change events. `cb` is invoked (with no
   * arguments) whenever the vendor signals a change; the registry responds by
   * calling `read()` again and applying the result. Returns an unsubscribe
   * function that detaches every listener the source attached. Must never throw.
   */
  subscribe(cb: () => void): () => void;
};

/**
 * Factory signature for a consent source. The registry constructs sources from
 * the names supplied in `config.consentSources`; a factory returns `null` when
 * it decides the source is not applicable (it is also valid to always return a
 * source whose `read()` yields `null` until the vendor appears).
 */
export type ConsentSourceFactory = () => ConsentSource | null;
