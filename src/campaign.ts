import { SdkConfig } from "./sdk-config";

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

export class Campaign {
  private campaignParams: Record<string, string>;

  constructor(private readonly sdkConfig: SdkConfig) {
    this.campaignParams = this._getParams();
  }

  getCampagingParams() {
    const params = this._getParams();
    if (this.sdkConfig.stickyCampaigns) {
      return { ...this.campaignParams, ...params };
    }
    return params;
  }

  private _getParams() {
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
