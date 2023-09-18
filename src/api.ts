import { EventPayload, SdkConfig } from "./sdk-config";

const API_URL = "https://api.logspot.io";

export const trackEvent = async (
  config: SdkConfig,
  payload: {
    event: string;
    channel?: string | null;
    message?: string | null;
    notify?: boolean | null;
    userId: string;
    metadata?: any | null;
    hostname?: string | null;
    url?: string | null;
    referrer?: string | null;
    language?: string | null;
    screen?: string | null;
  }
) => {
  if (!payload.event) {
    console.error("Logspot - event parameter is required");
    return;
  }

  try {
    let payloadToSend: EventPayload = {
      name: payload.event,
      channel: payload.channel,
      message: payload.message,
      notify: payload.notify,
      user_id: payload.userId,
      metadata: payload.metadata ?? {},
      hostname: payload.hostname,
      url: payload.url,
      referrer: payload.referrer?.length ? payload.referrer : null,
      language: payload.language,
      screen: payload.screen,
    };

    if (config.eventMapper) {
      payloadToSend = await config.eventMapper(payloadToSend);
    }

    await fetch(
      config.externalApiUrl ? config.externalApiUrl : `${API_URL}/i`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-logspot-pk": config.publicKey,
        },
        mode: "cors",
        body: JSON.stringify(payloadToSend),
      }
    );
  } catch (err) {
    console.error("Logspot - could not track event");
  }
};
