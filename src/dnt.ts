export const shouldDisableTracking = () => {
  const LOGSPOT_DNT = "lgspt_dnt";
  const urlSearchParams = new URLSearchParams(window.location.search);
  const params = Object.fromEntries((urlSearchParams as any).entries());

  const disableTracking =
    !!params.dnt || localStorage.getItem(LOGSPOT_DNT) === "1";

  if (!!params.dnt) {
    localStorage.setItem(LOGSPOT_DNT, "1");
  }

  return disableTracking;
};
