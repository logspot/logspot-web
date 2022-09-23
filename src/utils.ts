export const removeQueryParamsFromUrl = (url: string, params: string[]) => {
  try {
    const [base, queryString] = url.split("?");

    if (!queryString) {
      base;
    }

    const urlSearchParams = new URLSearchParams(queryString);
    const dirtyParams = urlSearchParams.entries();

    const cleaned = Array.from(dirtyParams).filter(
      ([param]) => !params.includes(param)
    );
    const reduced = cleaned.reduce((acc, [param, value]) => {
      return { ...acc, [param]: value };
    }, {});

    if (!cleaned.length) {
      return base;
    }

    const queryParams = new URLSearchParams(reduced);

    return `${base}?${queryParams}`;
  } catch (err) {
    return url;
  }
};
