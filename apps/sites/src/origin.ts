// The cross-site and cross-tenant guard on every shop POST (pages lane proposal 1.3). Every customer site is a
// subdomain of one root, so all of them are the same "site": a SameSite cookie travels on a post from one tenant's
// page to another's, and SameSite is no guard here. A post is accepted only when its Origin is exactly this
// request's own origin or, when a browser sent no Origin, when Sec-Fetch-Site says same-origin. Never same-site;
// with neither header, refused. Origin is "null" under Referrer-Policy no-referrer, which no shop page sends
// (headers.ts sends strict-origin-when-cross-origin).

export function isSameOriginPost(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === new URL(request.url).origin;
  return request.headers.get("sec-fetch-site") === "same-origin";
}
