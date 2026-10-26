/** Where an in-app link goes, without the origin: the path, the query (the admin's orders filters live there) and the hash. */
export const inAppPath = (url: URL): string => `${url.pathname}${url.search}${url.hash}`;
