export interface SdkConfig {
  publicKey: string;
  cookiesDisabled?: boolean;
  enableAutoPageviews?: boolean;
  enableAutoClicks?: boolean;
  externalApiUrl?: string;
  stickyCampaigns?: boolean;
  cookieDomain?: string;
  onLoad?: () => void | (() => Promise<void>);
}
