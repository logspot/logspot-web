export type EventPayload = {
  name: string;
  message?: string | null;
  notify?: boolean | null;
  user_id?: string;
  metadata?: any | null;
  hostname?: string | null;
  url?: string | null;
  referrer?: string | null;
  language?: string | null;
  screen?: string | null;
};

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
  eventMapper?: (payload: EventPayload) => EventPayload | (() => Promise<EventPayload>);
}
