/** The admin app's address on this computer: app.<host>:<port> → admin.<host>:<port + 1> (8787 → 8788; the demo's 28787 → 28788). Null when this is not an app.* address. */
export function adminOrigin(where: { protocol: string; hostname: string; port: string }): string | null {
  if (!where.hostname.startsWith("app.")) return null;
  const port = where.port === "" ? "" : `:${Number(where.port) + 1}`;
  return `${where.protocol}//admin.${where.hostname.slice("app.".length)}${port}`;
}
