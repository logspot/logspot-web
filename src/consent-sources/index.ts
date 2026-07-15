import type { ConsentSnapshot } from "../consent";
import type { ConsentSource, ConsentSourceFactory } from "./types";
import { createConcordSource } from "./concord";
import { createGcmReaderSource } from "./gcm-reader";
import { createOneTrustSource } from "./onetrust";
import { createUsercentricsSource } from "./usercentrics";
import { createCookiebotSource } from "./cookiebot";

export type { ConsentSource, ConsentSourceFactory } from "./types";

/**
 * Consent-source registry.
 *
 * Maps the source names a customer puts in `config.consentSources` (plumbed from
 * the CDN wrapper's `data-consent-source` attribute) to their factory. Accepts
 * both the canonical source ids and a couple of friendly aliases.
 */
const SOURCE_FACTORIES: Record<string, ConsentSourceFactory> = {
  concord: createConcordSource,
  onetrust: createOneTrustSource,
  usercentrics: createUsercentricsSource,
  cookiebot: createCookiebotSource,
  gcm: createGcmReaderSource,
  google_consent_mode: createGcmReaderSource,
};

const normalizeName = (name: string): string => name.trim().toLowerCase();

/**
 * Instantiate the consent sources named in `names`. Unknown names are skipped
 * (logged once); a factory returning `null` is skipped silently. Duplicate names
 * collapse to a single instance. Never throws.
 */
export const instantiateConsentSources = (
  names: string[]
): ConsentSource[] => {
  const seen = new Set<string>();
  const sources: ConsentSource[] = [];

  for (const rawName of names) {
    const key = normalizeName(rawName);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const factory = SOURCE_FACTORIES[key];
    if (!factory) {
      try {
        console.warn(`Logspot - unknown consent source "${rawName}" ignored`);
      } catch {
        // ignore
      }
      continue;
    }

    try {
      const source = factory();
      if (source) sources.push(source);
    } catch {
      // A misbehaving factory must never break init.
    }
  }

  return sources;
};

/**
 * Owns the lifecycle of the registered consent sources. On `start()` it reads
 * each source's current snapshot, applies it through `applySnapshot` (the store
 * enforces priority, so order does not matter), and subscribes to each source's
 * change events — re-reading and re-applying on every callback. `stop()` tears
 * down every subscription (used by `reset()`).
 *
 * `applySnapshot` is the SDK seam (`logspot.applyConsentSnapshot`): it returns a
 * promise resolving to whether the snapshot became authoritative. The registry
 * fires it and does not block source setup on the resulting `/consent` POST.
 */
export class ConsentSourceRegistry {
  private readonly sources: ConsentSource[];
  private readonly unsubscribers: Array<() => void> = [];
  private started = false;

  constructor(
    sources: ConsentSource[],
    private readonly applySnapshot: (
      snapshot: ConsentSnapshot
    ) => Promise<boolean>
  ) {
    this.sources = sources;
  }

  /** Number of registered sources (0 means the registry is a no-op). */
  get size(): number {
    return this.sources.length;
  }

  /**
   * Read each source's current state and subscribe for changes. Safe to call
   * when no vendor global is present yet: `read()` returns `null` (nothing
   * applied) and the subscriptions stay live so a later vendor load is picked
   * up. Idempotent — a second call is a no-op.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    for (const source of this.sources) {
      // Subscribe first so a change racing the initial read is not missed.
      try {
        const unsubscribe = source.subscribe(() => {
          this.applyFrom(source);
        });
        if (typeof unsubscribe === "function") {
          this.unsubscribers.push(unsubscribe);
        }
      } catch {
        // a source that cannot subscribe is still polled via its initial read
      }

      // Apply the current snapshot, if any.
      this.applyFrom(source);
    }
  }

  /** Read one source and push its snapshot through the priority-aware store. */
  private applyFrom(source: ConsentSource): void {
    let snapshot: ConsentSnapshot | null = null;
    try {
      snapshot = source.read();
    } catch {
      snapshot = null;
    }
    if (!snapshot) return;

    // Fire-and-forget: the store enforces priority and the SDK handles the
    // `/consent` push. We intentionally do not await here so source setup stays
    // synchronous; errors are swallowed so one source never breaks another.
    void this.applySnapshot(snapshot).catch(() => {});
  }

  /** Tear down every subscription. Called by `reset()`. Idempotent. */
  stop(): void {
    while (this.unsubscribers.length > 0) {
      const off = this.unsubscribers.pop();
      try {
        off?.();
      } catch {
        // ignore
      }
    }
    this.started = false;
  }
}
