import { eraseCookie, getCookie, setCookie } from "./cookie";
import { SdkConfig } from "./sdk-config";

export type Property = string | number | boolean;
export type Properties = Record<string, Property>;

export const b64EncodeUnicode = (str: string) => {
  return btoa(encodeURIComponent(str));
};

export const UnicodeDecodeB64 = (str: string) => {
  return decodeURIComponent(atob(str));
};

export const LOGSPOT_PROPS = "lgspt_p";

export class SuperProperties {
  private properties: Record<string, Property>;

  constructor(private readonly sdkConfig: SdkConfig) {
    const cookie = getCookie(LOGSPOT_PROPS);
    const decoded = cookie ? JSON.parse(UnicodeDecodeB64(cookie)) : {};
    this.properties = decoded;
  }

  register(newProps: Properties) {
    this.properties = { ...this.properties, ...newProps };
    this._save();
  }

  unregister(property: string) {
    delete this.properties[property];
    this._save();
  }

  clear() {
    this.properties = {};
    eraseCookie(LOGSPOT_PROPS);
  }

  getProperties() {
    return this.properties;
  }

  private _save() {
    if (this.sdkConfig.cookiesDisabled) {
      return;
    }
    setCookie(
      LOGSPOT_PROPS,
      b64EncodeUnicode(JSON.stringify(this.properties)),
      30
    );
  }
}
