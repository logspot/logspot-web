const setCookie = (name: string, value: string, days: number) => {
  let expires = "";
  if (days) {
    let date = new Date();
    date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
    expires = "; expires=" + date.toUTCString();
  }
  document.cookie = name + "=" + (value || "") + expires + "; path=/";
};

const getCookie = (name: string): string | null => {
  const nameEQ = name + "=";
  const ca = document.cookie.split(";");
  for (var i = 0; i < ca.length; i++) {
    let c = ca[i];
    while (c.charAt(0) == " ") c = c.substring(1, c.length);
    if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length, c.length);
  }
  return null;
};

const eraseCookie = (name: string) => {
  document.cookie = name + "=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;";
};

const LOGSPOT_COOKIE_ID = "lgspt_uid";
const API_URL = "https://api.logspot.io";

const getUid = () => {
  return (
    String.fromCharCode(Math.floor(Math.random() * 26) + 97) +
    Math.random().toString(16).slice(2) +
    Date.now().toString(16).slice(4)
  );
};

interface SdkConfig {
  publicKey: string;
  cookiesDisabled: boolean;
}

let sdkConfig: SdkConfig;

const init = (config: SdkConfig) => {
  sdkConfig = config;

  if (config.cookiesDisabled) {
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

  const uid = getCookie(LOGSPOT_COOKIE_ID);

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
        user_id: data.userId ?? uid,
        ...(data.metadata && { metadata: data.metadata }),
      }),
    });

    if (res.status !== 200) {
      const body = await res.json();
      console.debug("Logspot - ", body);
      return;
    }

    console.debug("Logspot - event tracked");
  } catch (err) {
    console.error("Logspot - could not track event");
  }
};

export default { init, track };
