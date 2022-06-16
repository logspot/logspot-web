import { trackEvent } from "./api";
import { eraseCookie, getCookie, setCookie } from "./cookies";
import { shouldDisableTracking } from "./dnt";
import { getUid } from "./uid";

interface SdkConfig {
  publicKey: string;
  cookiesDisabled: boolean;
}

export default (() => {
  const LOGSPOT_COOKIE_ID = "lgspt_uid";

  const disableTracking = shouldDisableTracking();

  let sdkConfig: SdkConfig;

  const init = (config: SdkConfig) => {
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

    await trackEvent(sdkConfig.publicKey, {
      event: data.event,
      message: data.message,
      notify: data.notify,
      userId: data.userId ?? uid,
      metadata: data.metadata ?? {},
    });

  };

  return { init, track };
})();
