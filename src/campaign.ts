import { getCookie, setCookie } from "./cookie";
import { SdkConfig } from "./sdk-config";
import { UnicodeDecodeB64, b64EncodeUnicode } from "./utils";

export const CAMPAIGN_KEYWORDS = [
  "gclid",
  "fbclid",
  "msclkid",
  "utm_source",
  "utm_id",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
];

const LOGSPOT_CAMPAIGN_COOKIE_ID = "lgspt_c";
// Separate, durable first-touch cookie. The `lgspt_c` cookie above tracks the
// CURRENT (last) touch and is rewritten on each sticky visit; `lgspt_ft` is
// written ONCE on the first visit that carries any campaign signal/referrer and
// is then NEVER overwritten, so first-touch attribution survives a
// multi-session, multi-day path to purchase (the headline attribution story).
const LOGSPOT_FIRST_TOUCH_COOKIE_ID = "lgspt_ft";
const DEFAULT_EXPIRATION = 7 * 24 * 60 * 60; // 7 days (current-touch cookie)
// First-touch must outlive any single campaign window — default 1 year.
const FIRST_TOUCH_EXPIRATION = 365 * 24 * 60 * 60;

export class Campaign {
  private campaignParams: Record<string, string>;

  constructor(private readonly sdkConfig: SdkConfig) {
    const cookieParams = this._getCampaignCookie();
    const params = { ...cookieParams, ...this._getParams() };
    if (sdkConfig.stickyCampaigns) {
      this._setCampaignCookie(params);
    }

    this.campaignParams = params;

    // Durable first-touch capture is independent of `stickyCampaigns` (which
    // governs the current-touch cookie). It is SET-ONCE: only written when no
    // first-touch cookie exists yet AND this visit carries a campaign signal or
    // referrer.
    this._captureFirstTouch();
  }

  getCampaignParams() {
    const params = this._getParams();
    if (this.sdkConfig.stickyCampaigns) {
      return { ...this.campaignParams, ...params };
    }
    return params;
  }

  /**
   * The durable first-touch params captured on the visitor's first campaign
   * visit (UTM/click-ids + referrer + landing url). Empty object when no
   * first-touch has been recorded (pure direct traffic so far). Read-only — the
   * cookie is never overwritten once set.
   */
  getFirstTouchParams(): Record<string, string> {
    return this._getFirstTouchCookie();
  }

  private _getCampaignCookie(): Record<string, string> {
    // A corrupt cookie throwing here would take down init() for its lifetime.
    try {
      const cookie = getCookie(LOGSPOT_CAMPAIGN_COOKIE_ID);
      return cookie ? JSON.parse(UnicodeDecodeB64(cookie)) : {};
    } catch {
      return {};
    }
  }

  private _setCampaignCookie(campaignParams: Record<string, string>) {
    setCookie({
      name: LOGSPOT_CAMPAIGN_COOKIE_ID,
      value: b64EncodeUnicode(JSON.stringify(campaignParams)),
      expiresInSeconds:
        this.sdkConfig.stickyCampaignsExpirationInSeconds ?? DEFAULT_EXPIRATION,
      domain: this.sdkConfig.cookieDomain ?? null,
    });
  }

  private _getParams(): Record<string, string> {
    const urlSearchParams = new URLSearchParams(window.location.search);
    const queryParams = Object.fromEntries(urlSearchParams.entries());

    return CAMPAIGN_KEYWORDS.reduce((acc, next) => {
      if (queryParams[next]?.length) {
        return { ...acc, [next]: queryParams[next] };
      }
      return acc;
    }, {});
  }

  private _getFirstTouchCookie(): Record<string, string> {
    try {
      const cookie = getCookie(LOGSPOT_FIRST_TOUCH_COOKIE_ID);
      return cookie ? JSON.parse(UnicodeDecodeB64(cookie)) : {};
    } catch {
      return {};
    }
  }

  /**
   * Persist the first-touch snapshot exactly once. A first-touch is recorded
   * only when the visit carries a campaign signal (any UTM/click-id) or a
   * referrer — pure direct first visits do not lock in an empty first-touch, so
   * a later campaign visit can still become the first-touch.
   */
  private _captureFirstTouch() {
    // Already captured → never overwrite (set-once).
    const existing = this._getFirstTouchCookie();
    if (Object.keys(existing).length > 0) {
      return;
    }

    const params = this._getParams();
    const rawReferrer =
      typeof document !== "undefined" ? document.referrer || "" : "";
    // A same-site referrer (page 2 of a direct visit) is not attributable and
    // must not lock in the set-once cookie ahead of a real campaign visit.
    const referrer = this._isExternalReferrer(rawReferrer) ? rawReferrer : "";
    const landingUrl =
      typeof window !== "undefined" && window.location
        ? window.location.href
        : "";

    const hasCampaignSignal = Object.keys(params).length > 0;
    const hasReferrer = referrer.length > 0;
    // Nothing to attribute on this visit — leave first-touch unset so a later
    // campaign visit can claim it.
    if (!hasCampaignSignal && !hasReferrer) {
      return;
    }

    const firstTouch: Record<string, string> = { ...params };
    if (hasReferrer) {
      firstTouch.referrer = referrer;
    }
    if (landingUrl) {
      firstTouch.landing_url = landingUrl;
    }

    setCookie({
      name: LOGSPOT_FIRST_TOUCH_COOKIE_ID,
      value: b64EncodeUnicode(JSON.stringify(firstTouch)),
      expiresInSeconds: FIRST_TOUCH_EXPIRATION,
      domain: this.sdkConfig.cookieDomain ?? null,
    });
  }

  private _isExternalReferrer(referrer: string): boolean {
    if (!referrer) return false;
    try {
      return new URL(referrer).host !== window.location.host;
    } catch {
      return true;
    }
  }
}
