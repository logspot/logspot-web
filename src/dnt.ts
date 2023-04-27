export const hasExplicitDNT = () => {
  const LOGSPOT_DNT = "lgspt_dnt";
  const urlSearchParams = new URLSearchParams(window.location.search);
  const params = Object.fromEntries((urlSearchParams as any).entries());

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
