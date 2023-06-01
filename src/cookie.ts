export const LOGSPOT_COOKIE_ID = "lgspt_uid";

export const ONE_DAY_IN_SECONDS = 24 * 60 * 60;
export const ONE_YEAR_IN_SECONDS = 12 * 30 * ONE_DAY_IN_SECONDS;

export const setCookie = ({
  name,
  value,
  expiresInSeconds,
  domain,
}: {
  name: string;
  value: string;
  expiresInSeconds: number;
  domain: string | null;
}) => {
  let date = new Date();
  date.setTime(date.getTime() + expiresInSeconds * 1000);
  const expires = "; expires=" + date.toUTCString();
  const domainProperty = domain ? `; domain=${domain}` : "";
  document.cookie =
    name + "=" + (value || "") + domainProperty + expires + "; path=/";
};

export const getCookie = (name: string): string | null => {
  const nameEQ = name + "=";
  const ca = document.cookie.split(";");
  for (var i = 0; i < ca.length; i++) {
    let c = ca[i];
    while (c.charAt(0) == " ") c = c.substring(1, c.length);
    if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length, c.length);
  }
  return null;
};

export const eraseCookie = (name: string) => {
  document.cookie = name + "=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;";
};
