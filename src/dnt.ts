export const shouldDisableTracking = () => {
  const LOGSPOT_DNT = "lgspt_dnt";
  const params: any = new Proxy(new URLSearchParams(window.location.search), {
    get: (searchParams, prop: string) => searchParams.get(prop),
  });

  const disableTracking =
    !!params.dnt || localStorage.getItem(LOGSPOT_DNT) === "1";

  if (!!params.dnt) {
    localStorage.setItem(LOGSPOT_DNT, "1");
  }

  return disableTracking;
};
