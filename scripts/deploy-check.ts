// pnpm deploy:check: refuses to let a Worker config go to production while it still holds a local
// placeholder. Run by the deploy runbook (Plan 2, final task) before every `wrangler deploy`.
// Usage: pnpm deploy:check            (every apps/*/wrangler.jsonc)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const PLACEHOLDER_DOMAIN = "asksite.example";
export const PLACEHOLDER_DATABASE_ID = "00000000-0000-0000-0000-000000000000";
const DAY = 86_400_000;
const SECRET_LIKE = /KEY|SECRET|TOKEN|PASSWORD/i;

interface WorkerConfig {
  workers_dev?: boolean;
  preview_urls?: boolean;
  observability?: { logs?: { invocation_logs?: boolean } };
  vars?: Record<string, string>;
  d1_databases?: Array<{ database_id?: string }>;
}

/** Everything that would make this config unsafe or broken in production. Empty means ready. */
export function deployProblems(text: string, now: number): string[] {
  const config = JSON.parse(text) as WorkerConfig;
  const vars = config.vars ?? {};
  const problems: string[] = [];
  if (text.includes(PLACEHOLDER_DOMAIN)) problems.push(`still uses the placeholder domain ${PLACEHOLDER_DOMAIN}`);
  if ((config.d1_databases ?? []).some((d) => d.database_id === PLACEHOLDER_DATABASE_ID)) problems.push("D1 database_id is still the local placeholder");
  if (vars["ENVIRONMENT"] !== "production") problems.push("vars.ENVIRONMENT must be production");
  // Each switch is checked only where a Worker has it (design §10.3); a present value must be the safe one.
  if (vars["MAILER"] !== undefined && vars["MAILER"] !== "resend") problems.push("vars.MAILER must be resend");
  if (vars["ADMIN_AUTH_MODE"] !== undefined && vars["ADMIN_AUTH_MODE"] !== "access") problems.push("vars.ADMIN_AUTH_MODE must be access");
  if (vars["MODEL_PROVIDER"] === "fake") problems.push("vars.MODEL_PROVIDER must not be fake");
  for (const name of Object.keys(vars)) if (SECRET_LIKE.test(name)) problems.push(`vars.${name} looks like a secret: use wrangler secret put`);
  if (/localhost|:\d+$/.test(vars["ROOT_DOMAIN"] ?? "")) problems.push("vars.ROOT_DOMAIN must be the real domain without a port");
  if (config.workers_dev !== false || config.preview_urls !== false) problems.push("workers_dev and preview_urls must be false");
  if (config.observability?.logs?.invocation_logs !== false) problems.push("observability.logs.invocation_logs must be false");
  const expires = vars["SECURITY_TXT_EXPIRES"];
  if (expires !== undefined) {
    const days = (Date.parse(expires) - now) / DAY;
    if (!(days >= 30 && days <= 366)) problems.push("vars.SECURITY_TXT_EXPIRES must be 30 to 366 days from today");
  }
  return problems;
}

function main(): void {
  const apps = resolve(import.meta.dirname, "../apps");
  let failed = false;
  for (const name of readdirSync(apps)) {
    const file = join(apps, name, "wrangler.jsonc");
    if (!existsSync(file)) continue;
    const problems = deployProblems(readFileSync(file, "utf8"), Date.now());
    console.log(problems.length === 0 ? `apps/${name}: ready` : `apps/${name}:\n  - ${problems.join("\n  - ")}`);
    failed ||= problems.length > 0;
  }
  if (failed) process.exit(1);
}

if (import.meta.main) main();
