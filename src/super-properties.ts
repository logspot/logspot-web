import { eraseCookie, getCookie, setCookie } from "./cookie";
import { SdkConfig } from "./sdk-config";

export type Property = string | number | boolean;
export type Properties = Record<string, Property>;
export class SuperProperties {
  LOGSPOT_PROPS = "lgspt_p";
  private expiryDays: number = 30;
  private properties: Record<string, Property>;

  constructor(private readonly sdkConfig: SdkConfig) {
    const cookie = getCookie(this.LOGSPOT_PROPS);
    const decoded = cookie ? JSON.parse(this.UnicodeDecodeB64(cookie)) : {};
    this.properties = decoded;
  }

  register(newProps: Properties, days?: number) {
    this.properties = { ...this.properties, ...newProps };

    if (typeof days !== "undefined") {
      this.expiryDays = days;
    }

    this._save();
  }

  unregister(property: string) {
    delete this.properties[property];
    this._save();
  }

  clear() {
    this.properties = {};
    eraseCookie(this.LOGSPOT_PROPS);
  }

  getProperties() {
    return this.properties;
  }

  private _save() {
    if (this.sdkConfig.cookiesDisabled) {
      return;
    }
    setCookie(
      this.LOGSPOT_PROPS,
      this.b64EncodeUnicode(JSON.stringify(this.properties)),
      this.expiryDays
    );
  }

  private b64EncodeUnicode(str: string) {
    return btoa(encodeURIComponent(str));
  }

  private UnicodeDecodeB64(str: string) {
    return decodeURIComponent(atob(str));
  }
}
