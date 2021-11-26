const API_URL = "https://api.logspot.io";

let sdkConfig: { publicKey: string };

const init = (config: { publicKey: string }) => {
  sdkConfig = config;
};

const track = async (data: {
  event: string;
  userId?: string;
  metadata?: Record<string, any>;
}) => {
  if (!sdkConfig || !sdkConfig.publicKey) {
    console.error(
      "Logspot - SDK not configured. You need to call: Logspot.init({publicKey: 'YOUR_PUBLIC_KEY'})"
    );
    return;
  }

  if (!data || !data.event) {
    console.error("Logspot - event parameter is required");
    return;
  }

  try {
    const res = await fetch(`${API_URL}/track`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-logspot-pk": sdkConfig.publicKey,
      },
      mode: "cors",
      body: JSON.stringify({
        name: data.event,
        ...(data.userId && { userId: data.userId }),
        ...(data.metadata && { metadata: data.metadata }),
      }),
    });

    if (res.status !== 200) {
      const body = await res.json();
      console.error("Logspot - ", body);
      return;
    }

    console.debug("Logspot - event tracked");
  } catch (err) {
    console.error("Logspot - could not track event");
  }
};

export default { init, track };
