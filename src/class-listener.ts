// Legacy always-on class-click listener. Attached unconditionally by `init()`,
// independent of autocapture, so existing `lgspt-*` customers keep working with
// zero behavior change even when autocapture is OFF.
//
// listen to class clicks starting with prefix lgspt-
// example: <div class="lgspt-imagine-cta">...</div>
// extract the name after the prefix
// split the name by dashes
// capitalize the first letter of each word
// join the words with spaces
//
// This coexists with the governed declarative `data-lgspt-event` path (handled
// in autocapture.ts, active whenever autocapture is enabled): the two fire on
// different markers and do not interfere.

const LOGSPOT_PREFIX = "lgspt-";

/**
 * Attach the always-on `lgspt-` classname click listener. Returns a teardown
 * that removes the listener (invoked on `reset()`); the listener semantics are
 * otherwise unchanged from the historical always-on behavior.
 */
export const listenToClassClicks = (
  trackClick: (data: { name: string }) => void
): (() => void) => {
  const onClick = (event: Event) => {
    const target = event.target as HTMLElement;

    if (new RegExp(LOGSPOT_PREFIX).test(target.className) === false) {
      return;
    }

    const classes = target.className.split(" ");
    const classList = classes.filter((className) =>
      className.startsWith(LOGSPOT_PREFIX)
    );
    if (classList.length === 0) {
      return;
    }
    const className = classList[0];
    const name = className
      .replace(LOGSPOT_PREFIX, "")
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
    const payload = {
      name,
    };

    trackClick(payload);
  };

  document.addEventListener("click", onClick);
  return () => document.removeEventListener("click", onClick);
};
