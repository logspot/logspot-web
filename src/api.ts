const API_URL = "https://api.logspot.io";

export const trackEvent = async (
  publicKey: string,
  payload: {
    event: string;
    message?: string | null;
    notify?: boolean | null;
    userId?: string | null;
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
    const res = await fetch(`${API_URL}/track`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-logspot-pk": publicKey,
      },
      mode: "cors",
      body: JSON.stringify({
        name: payload.event,
        message: payload.message,
        notify: payload.notify,
        user_id: payload.userId,
        metadata: payload.metadata ?? {},
        hostname: payload.hostname,
        url: payload.url,
        referrer: payload.referrer?.length ? payload.referrer : null,
        language: payload.language,
        screen: payload.screen,
      }),
    });

    if (res.status !== 200) {
      const body = await res.json();
      console.debug("Logspot - ", body);
      return;
    }

  } catch (err) {
    console.error("Logspot - could not track event");
  }
};
