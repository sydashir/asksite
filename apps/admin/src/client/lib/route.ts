export type AdminRoute =
  | { name: "queue" }
  | { name: "review"; versionId: string }
  | { name: "invites" }
  | { name: "sites" }
  | { name: "site"; siteId: string }
  | { name: "settings" }
  | { name: "notFound" };

const ID = "([0-9a-f-]{36})";

export function matchAdminRoute(pathname: string): AdminRoute {
  if (pathname === "/") return { name: "queue" };
  if (pathname === "/invites") return { name: "invites" };
  if (pathname === "/sites") return { name: "sites" };
  if (pathname === "/settings") return { name: "settings" };
  const review = new RegExp(`^/reviews/${ID}$`).exec(pathname);
  if (review?.[1] !== undefined) return { name: "review", versionId: review[1] };
  const site = new RegExp(`^/sites/${ID}$`).exec(pathname);
  if (site?.[1] !== undefined) return { name: "site", siteId: site[1] };
  return { name: "notFound" };
}
