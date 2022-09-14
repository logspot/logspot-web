import { trackEvent } from "./api";
import { eraseCookie, getCookie, LOGSPOT_COOKIE_ID, setCookie } from "./cookie";
import { shouldDisableTracking } from "./dnt";
import { SdkConfig } from "./sdk-config";
import { getUid } from "./user";

const script = () => {
  let sdkConfig: SdkConfig;
  let disableTracking: boolean;

  let getPageViewPayload: () => {
    hostname: string;
    screen: string;
    language: string;
  };

  let currentUrl: string;
  let currentRef: string;

  const init = (config: SdkConfig) => {
    if (typeof window === "undefined") {
      throw new Error("Logspot - script needs access to window object");
    }

    disableTracking = shouldDisableTracking();

    sdkConfig = config;

    const {
      screen: { width, height },
      navigator: { language },
      location: { hostname, pathname, search },
      document,
    } = window;

    const screen = `${width}x${height}`;

    currentUrl = `${pathname}${search}`;
    currentRef = document.referrer;

    if (config.cookiesDisabled || disableTracking) {
      eraseCookie(LOGSPOT_COOKIE_ID);
    } else {
      const uid = getCookie(LOGSPOT_COOKIE_ID);

      if (!uid) {
        setCookie(LOGSPOT_COOKIE_ID, getUid(), 5 * 12 * 30);
      }
    }

    getPageViewPayload = () => {
      return {
        hostname,
        screen,
        language,
      };
    };

    if (disableTracking) {
      return;
    }

    const update = () => {
      if (document.readyState === "complete") {
        if (sdkConfig.enableAutoPageviews) {
          pageview();
        }
        const bodyList = document.querySelector("body") as any;

        const observer = new MutationObserver(function (mutations) {
          mutations.forEach(function (mutation) {
            if (currentUrl != document.location.href) {
              const newUrl = document.location.href;
              currentRef = currentUrl;

              if (newUrl.substring(0, 4) === "http") {
                currentUrl = "/" + newUrl.split("/").splice(3).join("/");
              } else {
                currentUrl = newUrl;
              }

              if (currentUrl !== currentRef && sdkConfig.enableAutoPageviews) {
                pageview();
              }
            }
          });
        });

        const config = {
          childList: true,
          subtree: true,
        };

        observer.observe(bodyList, config);
      }

      document.addEventListener("readystatechange", update, true);

      update();
    };

    if (config.enableAutoClicks) {
      trackClicks();
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

    const payload = getPageViewPayload();

    await trackEvent(sdkConfig, {
      event: data.event,
      message: data.message,
      notify: data.notify,
      userId: data.userId ?? uid,
      hostname: payload.hostname,
      language: payload.language,
      referrer: currentRef,
      screen: payload.screen,
      url: currentUrl,
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

  const trackClicks = () => {
    const onClick = (event: MouseEvent): void => {
      const target = event.target as any;

      event.stopPropagation();

      if (target?.innerText && target?.innerText > 500) {
        return;
      }

      const text = target?.innerText?.slice(0, 500).trim();

      track({
        event: "Click",
        metadata: {
          id: target.id,
          tag: target.tagName,
          className: target.className,
          text,
          href: target.href,
        },
      });
    };

    document.addEventListener("click", onClick, false);
  };

  return { init, track, pageview };
};

export default script();
