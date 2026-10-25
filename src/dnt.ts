export const hasExplicitDNT = () => {
  const LOGSPOT_DNT = "lgspt_dnt";
  const urlSearchParams = new URLSearchParams(window.location.search);
  const params = Object.fromEntries((urlSearchParams as any).entries());

  // `?dnt=false` / `?dnt=0` lifts a prior opt-out; any other `?dnt` sets it.
  if (params.dnt === "false" || params.dnt === "0") {
    localStorage.removeItem(LOGSPOT_DNT);
    return false;
  }

  const queryWithDNT = typeof params.dnt !== "undefined";

  const disableTracking =
    queryWithDNT || localStorage.getItem(LOGSPOT_DNT) === "1";

  if (queryWithDNT) {
    localStorage.setItem(LOGSPOT_DNT, "1");
  }

  return disableTracking;
};

export const hasBrowserDNT = () => {
  return (
    navigator.doNotTrack === "1" ||
    navigator.doNotTrack === "yes" ||
    (window as any).doNotTrack === "1"
  );
};

// Set by WebDriver-driven browsers (Selenium, Playwright, Puppeteer), which can
// present an ordinary browser user agent the server-side bot filter accepts.
export const isAutomatedBrowser = () => navigator.webdriver === true;
