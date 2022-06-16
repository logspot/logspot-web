import { trackEvent } from "./api";
import { eraseCookie, getCookie, LOGSPOT_COOKIE_ID, setCookie } from "./cookie";
import { shouldDisableTracking } from "./dnt";
import { getUid } from "./user";

interface SdkConfig {
  publicKey: string;
  cookiesDisabled: boolean;
}

let sdkConfig: SdkConfig;
let disableTracking: boolean;

let getPageViewPayload: () => {
  hostname: string;
  screen: string;
  language: string;
  url: string;
  referrer: string;
};

const init = (config: SdkConfig) => {
  disableTracking = shouldDisableTracking();

  if (typeof window === "undefined") {
    throw new Error("Logspot - script needs access to window object");
  }

  sdkConfig = config;

  if (config.cookiesDisabled || disableTracking) {
    eraseCookie(LOGSPOT_COOKIE_ID);
  } else {
    const uid = getCookie(LOGSPOT_COOKIE_ID);

    if (!uid) {
      setCookie(LOGSPOT_COOKIE_ID, getUid(), 5 * 12 * 30);
    }
  }

  getPageViewPayload = () => {
    const {
      screen: { width, height },
      navigator: { language },
      location: { hostname, pathname, search },
      localStorage,
      document,
      history,
    } = window;

    const screen = `${width}x${height}`;
    let currentUrl = `${pathname}${search}`;
    let currentRef = document.referrer;
    
    return {
      hostname,
      screen,
      language,
      url: currentUrl,
      referrer: currentRef,
    };
  };
};

const track = async (data: {
  event: string;
  userId?: string;
  message?: string;
  notify?: boolean;
  metadata?: Record<string, any>;
}) => {
  if (disableTracking) {
    return;
  }

  if (!sdkConfig || !sdkConfig.publicKey) {
    console.error(
      "Logspot - SDK not configured. You need to call: Logspot.init({publicKey: 'YOUR_PUBLIC_KEY'})"
    );
    return;
  }

  const uid = getCookie(LOGSPOT_COOKIE_ID);

  const payload = getPageViewPayload();

  await trackEvent(sdkConfig.publicKey, {
    event: data.event,
    message: data.message,
    notify: data.notify,
    userId: data.userId ?? uid,
    hostname: payload.hostname,
    language: payload.language,
    referrer: payload.referrer,
    screen: payload.screen,
    url: payload.url,
    metadata: data.metadata ?? {},
  });
};

const pageview = async (data?: {
  userId?: string;
  metadata?: Record<string, any>;
}) => {
  await track({
    event: "Pageview",
    userId: data?.userId,
    metadata: data?.metadata,
  });
};

export default { init, track, pageview };
