export interface SdkConfig {
  publicKey: string;
  cookiesDisabled?: boolean;
  enableAutoPageviews?: boolean;
  enableAutoClicks?: boolean;
  externalApiUrl?: string;
  stickyCampaigns?: boolean;
  cookieDomain?: string;
  cookieExpirationInSeconds?: number;
  onLoad?: () => void | (() => Promise<void>);
}
