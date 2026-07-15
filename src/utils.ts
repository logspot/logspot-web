export const removeQueryParamsFromUrl = (url: string, params: string[]) => {
  try {
    // Split the hash off FIRST: it may follow the query, and splitting on `?`
    // alone would fold `#frag` into the last param value (or drop it).
    const hashIndex = url.indexOf("#");
    const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
    const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;

    const [base, queryString] = withoutHash.split("?");
    if (!queryString) {
      return `${base}${hash}`;
    }

    const cleaned = Array.from(
      new URLSearchParams(queryString).entries()
    ).filter(([param]) => !params.includes(param));
    if (!cleaned.length) {
      return `${base}${hash}`;
    }

    // append (not an object) preserves repeated params and their order.
    const queryParams = new URLSearchParams();
    for (const [param, value] of cleaned) queryParams.append(param, value);

    return `${base}?${queryParams}${hash}`;
  } catch (err) {
    return url;
  }
};

export const b64EncodeUnicode = (str: string) => {
  return btoa(encodeURIComponent(str));
};

export const UnicodeDecodeB64 = (str: string) => {
  return decodeURIComponent(atob(str));
};
