export interface SdkConfig {
  publicKey: string;
  cookiesDisabled?: boolean;
  enableAutoPageviews?: boolean;
  enableAutoClicks?: boolean;
  externalApiUrl?: string;
  onLoad: () => void | (() => Promise<void>);
}
