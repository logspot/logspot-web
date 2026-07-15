// Probe-checked localStorage access shared by every persistence layer.
// Returns null when storage is unavailable (SSR, disabled, quota, sandbox).
export const safeLocalStorage = (): Storage | null => {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
    const probeKey = "__logspot_probe__";
    window.localStorage.setItem(probeKey, "1");
    window.localStorage.removeItem(probeKey);
    return window.localStorage;
  } catch {
    return null;
  }
};
