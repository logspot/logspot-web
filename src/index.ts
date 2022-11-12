import { trackEvent } from "./api";
import { Campaign, CAMPAIGN_KEYWORDS } from "./campaign";
import { eraseCookie, getCookie, LOGSPOT_COOKIE_ID, setCookie } from "./cookie";
import { shouldDisableTracking } from "./dnt";
import { SdkConfig } from "./sdk-config";
import { Properties, SuperProperties } from "./super-properties";
import { getUid } from "./user";
import { removeQueryParamsFromUrl } from "./utils";

const DEFAULT_CONFIG = {
  cookiesDisabled: false,
  enableAutoPageviews: true,
  enableAutoClicks: false,
};

const Logspot = () => {
  let sdkConfig: SdkConfig;
  let disableTracking: boolean;

  let getPageViewPayload: () => {
    hostname: string;
    screen: string;
    language: string;
  };

  let currentUrl: string;
  let currentRef: string;
  let userId: string;
  let superProperties: SuperProperties;
  let campaign: Campaign;

  const init = async (config: SdkConfig) => {
    if (typeof window === "undefined") {
      throw new Error("Logspot - script needs access to window object");
    }

    disableTracking = shouldDisableTracking();

    if (disableTracking) {
      return;
    }

    sdkConfig = {
      ...DEFAULT_CONFIG,
      ...config,
    };

    superProperties = new SuperProperties(sdkConfig);
    campaign = new Campaign(sdkConfig);

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
      userId = getUid();
    } else {
      const cookie = getCookie(LOGSPOT_COOKIE_ID);
      userId = cookie ?? getUid();

      if (!cookie) {
        setCookie(LOGSPOT_COOKIE_ID, userId, 5 * 12 * 30, sdkConfig.cookieDomain);
      }
    }

    getPageViewPayload = () => {
      return {
        hostname,
        screen,
        language,
      };
    };

    if (sdkConfig.onLoad) {
      await sdkConfig.onLoad();
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
    };

    document.addEventListener("readystatechange", update, true);
    update();

    if (config.enableAutoClicks) {
      captureClicks();
    }
  };

  const track = async (data: {
    event: string;
    userId?: string;
    message?: string;
    notify?: boolean;
    metadata?: Record<string, any>;
  }) => {
    if (!sdkConfig || disableTracking) {
      return;
    }

    if (!sdkConfig || (!sdkConfig.externalApiUrl && !sdkConfig.publicKey)) {
      console.error(
        "Logspot - SDK not configured. You need to call: Logspot.init({publicKey: 'YOUR_PUBLIC_KEY'})"
      );
      return;
    }

    const payload = getPageViewPayload();
    const { userId: propsUserId, ...props } = superProperties.getProperties();
    const campaignParams = campaign.getCampagingParams();

    const cleanedUrl = removeQueryParamsFromUrl(currentUrl, CAMPAIGN_KEYWORDS);

    await trackEvent(sdkConfig, {
      event: data.event,
      message: data.message,
      notify: data.notify,
      userId: data.userId ?? (propsUserId ? `${propsUserId}` : null) ?? userId,
      hostname: payload.hostname,
      language: payload.language,
      referrer: currentRef,
      screen: payload.screen,
      url: cleanedUrl,
      metadata: {
        ...campaignParams,
        ...props,
        ...(data.metadata ?? {}),
      },
    });
  };

  const pageview = async (data?: {
    userId?: string;
    metadata?: Record<string, any>;
  }) => {
    if (!sdkConfig || disableTracking) {
      return;
    }

    await track({
      event: "Pageview",
      userId: data?.userId,
      metadata: data?.metadata,
    });
  };

  const captureClicks = () => {
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

  const register = (properties: Properties) => {
    if (!sdkConfig || disableTracking) {
      return true;
    }
    return superProperties.register(properties);
  };

  const getProperties = () => {
    if (!sdkConfig || disableTracking) {
      return {};
    }
    return superProperties.getProperties();
  };

  const unregister = (property: string) => {
    if (!sdkConfig || disableTracking) {
      return;
    }
    superProperties.unregister(property);
  };

  const reset = () => {
    if (!sdkConfig || disableTracking) {
      return;
    }

    eraseCookie(LOGSPOT_COOKIE_ID);
    superProperties.clear();

    userId = getUid();

    if (!sdkConfig.cookiesDisabled && !disableTracking) {
      setCookie(LOGSPOT_COOKIE_ID, userId, 5 * 12 * 30, sdkConfig.cookieDomain);
    }
  };

  return { init, track, pageview, register, unregister, reset, getProperties };
};

export const logspot = Logspot();
export default logspot;
