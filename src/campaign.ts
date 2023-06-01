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
const DEFAULT_EXPIRATION = 7 * 24 * 60 * 60; // 7 days

export class Campaign {
  private campaignParams: Record<string, string>;

  constructor(private readonly sdkConfig: SdkConfig) {
    const cookieParams = this._getCamapignCookie();
    const params = { ...cookieParams, ...this._getParams() };
    if (sdkConfig.stickyCampaigns) {
      this._setCampaignCookie(params);
    }

    this.campaignParams = params;
  }

  getCampagingParams() {
    const params = this._getParams();
    if (this.sdkConfig.stickyCampaigns) {
      return { ...this.campaignParams, ...params };
    }
    return params;
  }

  private _getCamapignCookie(): Record<string, string> {
    const cookie = getCookie(LOGSPOT_CAMPAIGN_COOKIE_ID);
    const decoded = cookie ? JSON.parse(UnicodeDecodeB64(cookie)) : {};
    return decoded;
  }

  private _setCampaignCookie(campaignParams: Record<string, string>) {
    setCookie({
      name: LOGSPOT_CAMPAIGN_COOKIE_ID,
      value: b64EncodeUnicode(JSON.stringify(campaignParams)),
      expiresInSeconds:
        this.sdkConfig.cookieExpirationInSeconds ?? DEFAULT_EXPIRATION,
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
}
