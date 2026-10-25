// Engaged-time tracking. Off unless the project (dashboard, via remote config)
// or the snippet turns it on, because every mode sends extra billed events.
//
// - "leave": a "Page Leave" event when the page is hidden or left, carrying
//   the visible seconds since the last report. Session duration is computed as
//   last event minus first, so this alone stretches it to the real exit time.
// - "heartbeat": "leave" plus a "Page Heartbeat" each minute the page stays
//   visible, for visitors whose leave event never arrives (killed tabs).

export type EngagementMode = "off" | "leave" | "heartbeat";

export const ENGAGEMENT_MODES: readonly EngagementMode[] = [
  "off",
  "leave",
  "heartbeat",
];

export const PAGE_LEAVE_EVENT = "Page Leave";
export const PAGE_HEARTBEAT_EVENT = "Page Heartbeat";

export const HEARTBEAT_INTERVAL_MS = 60_000;
// Caps keep a tab left open (or flipped between) from billing without end.
export const MAX_HEARTBEATS_PER_PAGE = 30;
export const MAX_LEAVES_PER_PAGE = 10;

const MIN_REPORT_MS = 1_000;

export const isEngagementMode = (value: unknown): value is EngagementMode =>
  (ENGAGEMENT_MODES as readonly unknown[]).includes(value);

export type EngagementTracker = {
  /** Report the page being left, then start counting for the next one. */
  pageChanged: () => void;
  teardown: () => void;
};

/**
 * Count visible time on the current page and report it per `mode`. `send`
 * must capture the page context synchronously (the leave report for an SPA
 * route change fires before the SDK advances to the new url).
 */
export const setupEngagement = (opts: {
  mode: Exclude<EngagementMode, "off">;
  send: (event: string, metadata: { engaged_seconds: number }) => void;
  now?: () => number;
}): EngagementTracker => {
  const now = opts.now ?? Date.now;
  const isVisible = () => document.visibilityState === "visible";

  let visibleSince: number | null = isVisible() ? now() : null;
  let unreportedMs = 0;
  let leaves = 0;
  let heartbeats = 0;

  const collect = () => {
    if (visibleSince !== null) {
      const at = now();
      unreportedMs += at - visibleSince;
      visibleSince = isVisible() ? at : null;
    }
  };

  const report = (event: string) => {
    if (unreportedMs < MIN_REPORT_MS) return false;
    opts.send(event, { engaged_seconds: Math.round(unreportedMs / 1000) });
    unreportedMs = 0;
    return true;
  };

  const leave = () => {
    collect();
    if (leaves < MAX_LEAVES_PER_PAGE && report(PAGE_LEAVE_EVENT)) leaves++;
  };

  const onVisibilityChange = () => {
    if (isVisible()) {
      if (visibleSince === null) visibleSince = now();
    } else {
      leave();
    }
  };

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", leave);

  const timer =
    opts.mode === "heartbeat"
      ? setInterval(() => {
          if (!isVisible() || heartbeats >= MAX_HEARTBEATS_PER_PAGE) return;
          collect();
          if (report(PAGE_HEARTBEAT_EVENT)) heartbeats++;
        }, HEARTBEAT_INTERVAL_MS)
      : null;

  return {
    pageChanged: () => {
      leave();
      leaves = 0;
      heartbeats = 0;
      unreportedMs = 0;
      visibleSince = isVisible() ? now() : null;
    },
    teardown: () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", leave);
      if (timer !== null) clearInterval(timer);
    },
  };
};
