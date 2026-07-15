import {
  eraseCookie,
  getCookie,
  LOGSPOT_COOKIE_ID,
  ONE_YEAR_IN_SECONDS,
  setCookie,
} from "./cookie";
import { safeLocalStorage } from "./safe-storage";

export const LOGSPOT_ANONYMOUS_ID_KEY = "lgspt_anonymous_id";

// Server-side cap on anonymous_id length; matches IdentifyDto in the platform
// repo. Used to drop oversized legacy lgspt_uid values during migration.
const MAX_ANONYMOUS_ID_LENGTH = 64;

/**
 * Generate a v4 UUID. Prefer crypto.randomUUID() (modern browsers); fall back
 * to a Math.random-based implementation for older environments.
 */
export const generateAnonymousId = (): string => {
  try {
    const c: { randomUUID?: () => string } | undefined =
      typeof crypto !== "undefined" ? (crypto as any) : undefined;
    if (c && typeof c.randomUUID === "function") {
      return c.randomUUID();
    }
  } catch {
    // fall through to Math.random fallback
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

type AnonymousIdStorageOptions = {
  cookiesDisabled?: boolean;
  cookieDomain?: string | null;
  cookieExpirationInSeconds?: number;
};

const tryReadCookie = (name: string): string | null => {
  try {
    return getCookie(name);
  } catch {
    return null;
  }
};

const tryWriteCookie = (
  value: string,
  opts: AnonymousIdStorageOptions
): boolean => {
  try {
    setCookie({
      name: LOGSPOT_ANONYMOUS_ID_KEY,
      value,
      expiresInSeconds: opts.cookieExpirationInSeconds ?? ONE_YEAR_IN_SECONDS,
      domain: opts.cookieDomain ?? null,
    });
    return getCookie(LOGSPOT_ANONYMOUS_ID_KEY) === value;
  } catch {
    return false;
  }
};

const tryReadLocalStorage = (): string | null => {
  const ls = safeLocalStorage();
  if (!ls) return null;
  try {
    return ls.getItem(LOGSPOT_ANONYMOUS_ID_KEY);
  } catch {
    return null;
  }
};

const tryWriteLocalStorage = (value: string): boolean => {
  const ls = safeLocalStorage();
  if (!ls) return false;
  try {
    ls.setItem(LOGSPOT_ANONYMOUS_ID_KEY, value);
    return true;
  } catch {
    return false;
  }
};

let inMemoryAnonymousId: string | null = null;

/**
 * Read existing anonymous id from cookie -> legacy SDK cookie -> localStorage
 * -> in-memory. The legacy `lgspt_uid` cookie was the old anonymous browser id;
 * migrating it preserves pre-identify history without continuing to send it as
 * `user_id`.
 */
export const readAnonymousId = (opts: AnonymousIdStorageOptions): string | null => {
  if (!opts.cookiesDisabled) {
    const fromCookie = tryReadCookie(LOGSPOT_ANONYMOUS_ID_KEY);
    if (fromCookie) return fromCookie;

    const fromLegacyCookie = tryReadCookie(LOGSPOT_COOKIE_ID);
    if (fromLegacyCookie && fromLegacyCookie.length <= MAX_ANONYMOUS_ID_LENGTH) {
      return fromLegacyCookie;
    }
  }

  const fromLs = tryReadLocalStorage();
  if (fromLs) return fromLs;

  return inMemoryAnonymousId;
};

/**
 * Persist the anonymous id through the storage chain. Cookie attempted first
 * (unless disabled), then localStorage, then in-memory as last resort.
 */
export const writeAnonymousId = (
  value: string,
  opts: AnonymousIdStorageOptions
): void => {
  if (!opts.cookiesDisabled) {
    tryWriteCookie(value, opts);
  }
  tryWriteLocalStorage(value);
  inMemoryAnonymousId = value;
};

/** Clear the anonymous id from every storage layer. Used by reset(). */
export const clearAnonymousId = (opts: AnonymousIdStorageOptions): void => {
  try {
    eraseCookie(LOGSPOT_ANONYMOUS_ID_KEY, opts.cookieDomain ?? null);
  } catch {
    // ignore
  }

  try {
    eraseCookie(LOGSPOT_COOKIE_ID, opts.cookieDomain ?? null);
  } catch {
    // ignore
  }

  const ls = safeLocalStorage();
  if (ls) {
    try {
      ls.removeItem(LOGSPOT_ANONYMOUS_ID_KEY);
    } catch {
      // ignore
    }
  }

  inMemoryAnonymousId = null;
};

/**
 * Get-or-create: return existing anonymous id if present, otherwise generate
 * a new one and persist it.
 */
export const ensureAnonymousId = (opts: AnonymousIdStorageOptions): string => {
  const existing = readAnonymousId(opts);
  if (existing) {
    inMemoryAnonymousId = existing;
    writeAnonymousId(existing, opts);
    return existing;
  }
  const fresh = generateAnonymousId();
  writeAnonymousId(fresh, opts);
  return fresh;
};

/** Force-rotate: generate a new anonymous id, clear all old layers, persist new. */
export const rotateAnonymousId = (opts: AnonymousIdStorageOptions): string => {
  clearAnonymousId(opts);
  const fresh = generateAnonymousId();
  writeAnonymousId(fresh, opts);
  return fresh;
};

/** Test-only: reset the in-memory fallback. */
export const __resetInMemoryAnonymousIdForTests = (): void => {
  inMemoryAnonymousId = null;
};
