// Stripe Payment Links can't carry per-visitor metadata, so the platform
// reads `client_reference_id` as the fallback carrier for the anonymous id.
// Tagging the href just before navigation saves appending it by hand.

const STRIPE_PAYMENT_LINK_HOST = "buy.stripe.com";
const CLIENT_REFERENCE_PARAM = "client_reference_id";

/** The href with the anonymous id added, or null when it should be left as is. */
export const tagPaymentLinkHref = (
  href: string,
  anonymousId: string
): string | null => {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.hostname !== STRIPE_PAYMENT_LINK_HOST) return null;
  // Never overwrite an id the customer set themselves.
  if (url.searchParams.has(CLIENT_REFERENCE_PARAM)) return null;
  url.searchParams.set(CLIENT_REFERENCE_PARAM, anonymousId);
  return url.toString();
};

// Each anchor's href from before our tag, so a later press (after reset()
// rotated the visitor id) re-tags from it instead of keeping the old id. Module
// scope so it survives re-init.
const ownTags = new WeakMap<HTMLAnchorElement, { from: string; to: string }>();

/**
 * Tag Stripe Payment Link anchors on press. `pointerdown` runs before the
 * context menu, so "open in new tab" gets the tagged href too; `click` and
 * `auxclick` cover keyboard activation and middle-click. Returns a teardown.
 */
export const listenForPaymentLinks = (opts: {
  getAnonymousId: () => string | null;
  shouldTag: () => boolean;
}): (() => void) => {
  const onPress = (event: Event) => {
    if (!opts.shouldTag()) return;
    const target = event.target as Element | null;
    const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
    const anonymousId = opts.getAnonymousId();
    if (!anchor || !anonymousId) return;
    const own = ownTags.get(anchor);
    const from = own && own.to === anchor.href ? own.from : anchor.href;
    const tagged = tagPaymentLinkHref(from, anonymousId);
    if (tagged) {
      anchor.href = tagged;
      ownTags.set(anchor, { from, to: anchor.href });
    }
  };

  const events = ["pointerdown", "click", "auxclick"] as const;
  for (const name of events) {
    document.addEventListener(name, onPress, true);
  }
  return () => {
    for (const name of events) {
      document.removeEventListener(name, onPress, true);
    }
  };
};
