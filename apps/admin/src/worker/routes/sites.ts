import { ApiError, auditStatement, cleanOwnerText, logLine, readJson, runToEnd, siteNoticeEmail, trySend } from "@asksite/app-common";
import { DisableOwnerBody, IndexableBody, TakedownBody, type AuditRow, type GenerationRow, type SiteVersionRow } from "@asksite/core";
import { Hono } from "hono";
import { z } from "zod";
import type { TakedownView } from "../../settings-view.ts";
import { mailerEnv, siteWithOwner, toAdminSiteRow, toVersionSummary, type AdminSiteColumns } from "../db.ts";
import type { AdminDeps, PublishErrorLike } from "../deps.ts";
import { publishApiError, type PublishAction } from "../publish-errors.ts";
import { GENERATION_HISTORY, SITE_AUDIT, SITE_LIST, SITE_LIST_TAIL, VERSION_HISTORY } from "../queries.ts";
import type { AdminEnv } from "../types.ts";

const FILTERS = {
  live: "s.live_version_id IS NOT NULL AND s.taken_down_at IS NULL",
  in_review: "s.pending_version_id IS NOT NULL",
  taken_down: "s.taken_down_at IS NOT NULL",
  draft: "s.live_version_id IS NULL AND s.pending_version_id IS NULL AND s.taken_down_at IS NULL",
  all: "1 = 1",
} as const;

const SiteFilter = z.enum(["live", "in_review", "taken_down", "draft", "all"]).default("all");

/** Sites, takedown and restore, search-engine switch, and owner disable / enable (§3.2 step 4, §4.5). */
export function siteRoutes(deps: AdminDeps): Hono<AdminEnv> {
  const sites = new Hono<AdminEnv>();

  /** Runs a publishing call and turns its expected failures into the admin API's answers. */
  async function publishing<T>(run: () => Promise<T>, action: PublishAction): Promise<T> {
    try {
      return await run();
    } catch (err) {
      const mapped = err instanceof deps.publishing.PublishError ? publishApiError((err as PublishErrorLike).code, action, (err as PublishErrorLike).detail) : null;
      throw mapped ?? err;
    }
  }

  /** Whether the site's takedown committed. A read that fails counts as "not down", so the caller rethrows its original error. */
  async function isTakenDown(db: D1Database, siteId: string): Promise<boolean> {
    try {
      const row = await db.prepare("SELECT taken_down_at FROM sites WHERE id = ?").bind(siteId).first<{ taken_down_at: number | null }>();
      return row?.taken_down_at != null;
    } catch {
      return false;
    }
  }

  /** A takedown's lease ran out (site_busy, reason lease_lost): the takedown may have committed. */
  function isLeaseLost(err: unknown): boolean {
    if (!(err instanceof deps.publishing.PublishError)) return false;
    const { code, detail } = err as PublishErrorLike;
    return code === "site_busy" && typeof detail === "object" && detail !== null && (detail as Record<string, unknown>)["reason"] === "lease_lost";
  }

  /** The site's stored taken_down_at (null: up). undefined: the read failed, so the caller falls back to what it knew before. */
  async function storedTakedownAt(db: D1Database, siteId: string): Promise<number | null | undefined> {
    try {
      return (await db.prepare("SELECT taken_down_at FROM sites WHERE id = ?").bind(siteId).first<{ taken_down_at: number | null }>())?.taken_down_at ?? null;
    } catch {
      return undefined;
    }
  }

  sites.get("/sites", async (c) => {
    const filter = SiteFilter.safeParse(c.req.query("filter"));
    if (!filter.success) throw new ApiError("bad_request", "Unknown filter");
    const { results } = await c.env.DB.prepare(`${SITE_LIST} WHERE ${FILTERS[filter.data]} ${SITE_LIST_TAIL}`).all<AdminSiteColumns>();
    return c.json({ sites: results.map(toAdminSiteRow) });
  });

  sites.get("/sites/:siteId", async (c) => {
    const db = c.env.DB;
    const site = await siteWithOwner(db, c.req.param("siteId"));
    const [versions, generations, leads, audit] = await Promise.all([
      db.prepare(VERSION_HISTORY).bind(site.id).all<Pick<SiteVersionRow, "id" | "number" | "status" | "requested_at" | "reviewed_at" | "review_note">>(),
      db.prepare(GENERATION_HISTORY).bind(site.id).all<GenerationRow>(),
      db.prepare("SELECT COUNT(*) AS n FROM leads WHERE site_id = ?").bind(site.id).first<{ n: number }>(),
      db.prepare(SITE_AUDIT).bind(site.id).all<Pick<AuditRow, "at" | "actor" | "action" | "detail_json">>(),
    ]);
    return c.json({
      site: toAdminSiteRow(site),
      // The moment the takedown happened, which Restore must send back (A16-4c): a restore refuses a different takedown. AdminSiteRow (core) has no field for it.
      takenDownAt: site.taken_down_at,
      versions: versions.results.map(toVersionSummary),
      generations: generations.results.map((g) => ({
        ...deps.generation.toGenerationView(g),
        provider: g.provider,
        model: g.model,
        costMicrousd: g.cost_microusd,
        attempts: g.attempts,
      })),
      leadCount: leads?.n ?? 0,
      audit: audit.results.map((a) => ({ at: a.at, actor: a.actor, action: a.action, detail: a.detail_json === null ? null : JSON.parse(a.detail_json) })),
    });
  });

  sites.post("/sites/:siteId/takedown", async (c) => {
    const body = await readJson(c, TakedownBody);
    const site = await siteWithOwner(c.env.DB, c.req.param("siteId"));
    // The notice is built before anything changes, so a configuration error (MAILER, APP_ORIGIN) is a 500 that
    // leaves the site up. After the takedown commits the notice is sent inside the same runToEnd and the answer says
    // whether it went out: a takedown is never undone by a failed email, but the admin must learn the owner was not told.
    const mailer = deps.createMailer(mailerEnv(c.env));
    // Read before takeDown runs. It only decides the fallback below: whether THIS call took the site down is decided after takeDown
    // ran, from the stored taken_down_at, because another admin may commit between this read and this call's lease.
    const alreadyDown = site.taken_down_at !== null;
    const now = Date.now();
    // The owner reads this message: hidden characters go first, and a message with nothing left is no message.
    const cleanedMessage = cleanOwnerText(body.ownerMessage ?? "");
    const ownerMessage = cleanedMessage === "" ? null : cleanedMessage;
    // The owner always hears about it, with the admin's message when there is one, and where to ask (decision 34).
    const email = siteNoticeEmail({ appOrigin: c.env.APP_ORIGIN, supportEmail: c.env.SUPPORT_EMAIL, ownerMessage });
    // Plan 2's takeDown commits a D1 batch, then deletes LIVE, then purges MEDIA: it runs to its end even if the client goes away.
    // trySend never throws (it logs the mailer's code or error class only, never the address or the content).
    const view = await publishing(
      () =>
        runToEnd(
          c.executionCtx,
          (async (): Promise<TakedownView> => {
            // Every timestamp this call hands to takeDown: the site was taken down by this call only if the stored taken_down_at is one of them.
            const stamps: number[] = [];
            const takeDown = (at: number) => {
              stamps.push(at);
              return deps.publishing.takeDown(c.env, { siteId: site.id, reviewer: c.get("admin"), reason: body.reason, purgeMedia: body.purgeMedia, now: at });
            };
            let cleanupFailed = false;
            let leaseLost: unknown = null;
            try {
              await takeDown(now);
            } catch (err) {
              // A lease_lost may come after the commit (A16-4c: takeDown asserts its lease again before the LIVE deletes, so it means "the
              // takedown may have committed"): it is answered as the admin's 409 and the page offers Finish the takedown, but only AFTER the
              // owner notice below, so a call that took the site down tells the owner whether or not it kept its lease.
              // Any other PublishError is rethrown as it is. Any other error may have come after the commit too (LIVE delete, media purge):
              // if the site is down, run the takedown once more (Plan 2's takeDown is idempotent) before giving up on the cleanup.
              if (isLeaseLost(err)) leaseLost = err;
              else if (err instanceof deps.publishing.PublishError || !(await isTakenDown(c.env.DB, site.id))) throw err;
              else {
                try {
                  await takeDown(Date.now());
                } catch {
                  cleanupFailed = true;
                  logLine({ event: "takedown_cleanup_failed", siteId: site.id });
                }
              }
            }
            // The takedown's stored moment decides who took the site down. If the read fails, fall back to the read made before takeDown.
            const stored = await storedTakedownAt(c.env.DB, site.id);
            const tookItDown = stored === undefined ? !alreadyDown : stored !== null && stamps.includes(stored);
            // The key names the takedown (its stored moment), so every call that sends the notice for it is the same message to the mail provider.
            const send = () => trySend(mailer, { to: site.owner_email, ...email, replyTo: c.env.SUPPORT_EMAIL, tag: "site_notice", idempotencyKey: `takedown:${site.id}:${stored ?? site.taken_down_at ?? now}` });
            // A lost lease: tell the owner if THIS call took the site down (the re-read decides; a failed re-read falls back toward sending), then answer the 409.
            if (leaseLost !== null) {
              if (tookItDown) await send();
              throw leaseLost;
            }
            // Plan 2 audits only the call that took the site down (and a later purge that deleted something), so a re-run that
            // only finishes the clean-up would leave no trace of this admin action: record it here.
            if (!tookItDown) {
              const detail = { reason: body.reason, purgeMedia: body.purgeMedia, repeat: true };
              await auditStatement(c.env.DB, { at: Date.now(), actor: `admin:${c.get("admin")}`, action: "site.taken_down", siteId: site.id, detail }).run();
            }
            // The owner is told once: only the call that took the site down sends the notice, so a re-run (every Finish the takedown) never emails.
            return { noticeSent: tookItDown ? await send() : null, ...(cleanupFailed ? { cleanupFailed: true as const } : {}) };
          })(),
        ),
      "takedown",
    );
    return c.json(view);
  });

  sites.post("/sites/:siteId/restore", async (c) => {
    // expectedTakenDownAt is the taken_down_at the admin's page showed: Plan 2's restore refuses a different (later) takedown.
    const { expectedTakenDownAt } = await readJson(c, z.strictObject({ expectedTakenDownAt: z.number().int().positive() }));
    const site = await siteWithOwner(c.env.DB, c.req.param("siteId"));
    // Plan 2's restore puts the page in LIVE, then commits a D1 batch: it runs to its end even if the client goes away.
    return c.json(
      await publishing(() => runToEnd(c.executionCtx, deps.publishing.restore(c.env, { siteId: site.id, reviewer: c.get("admin"), expectedTakenDownAt, now: Date.now() })), "restore"),
    );
  });

  sites.post("/sites/:siteId/copy-pages", async (c) => {
    await readJson(c, z.strictObject({}));
    const site = await siteWithOwner(c.env.DB, c.req.param("siteId"));
    // Copies the live version's pages to LIVE again and rewrites the pointer: it never touches taken_down_at (a taken-down site is refused),
    // changes no D1 row and writes no audit row (Plan 2's copyLivePagesAgain). Several R2 writes, so it runs to its end like restore.
    return c.json(await publishing(() => runToEnd(c.executionCtx, deps.publishing.copyLivePagesAgain(c.env, { siteId: site.id, reviewer: c.get("admin"), now: Date.now() })), "copy"));
  });

  sites.put("/sites/:siteId/indexable", async (c) => {
    const { indexable } = await readJson(c, IndexableBody);
    const site = await siteWithOwner(c.env.DB, c.req.param("siteId"));
    // One D1 batch (Plan 2's setIndexable): all or nothing, so it needs no runToEnd.
    await publishing(() => deps.publishing.setIndexable(c.env, { siteId: site.id, reviewer: c.get("admin"), indexable, now: Date.now() }), "change");
    return c.json({});
  });

  /** 404 for an unknown owner before anything is written, so a refused change leaves no audit row (owners are never deleted). */
  async function knownOwner(db: D1Database, ownerId: string): Promise<void> {
    const owner = await db.prepare("SELECT 1 AS found FROM owners WHERE id = ?").bind(ownerId).first();
    if (owner === null) throw new ApiError("not_found", "Not found");
  }

  sites.post("/owners/:ownerId/disable", async (c) => {
    const { reason } = await readJson(c, DisableOwnerBody);
    const ownerId = c.req.param("ownerId");
    const db = c.env.DB;
    const now = Date.now();
    await knownOwner(db, ownerId);
    await db.batch([
      db.prepare("UPDATE owners SET disabled_at = ?, disabled_reason = ? WHERE id = ?").bind(now, reason, ownerId),
      db.prepare("DELETE FROM sessions WHERE owner_id = ?").bind(ownerId),
      auditStatement(db, { at: now, actor: `admin:${c.get("admin")}`, action: "owner.disabled", siteId: null, detail: { ownerId, reason } }),
    ]);
    return c.json({});
  });

  sites.post("/owners/:ownerId/enable", async (c) => {
    await readJson(c, z.strictObject({}));
    const ownerId = c.req.param("ownerId");
    const db = c.env.DB;
    const now = Date.now();
    await knownOwner(db, ownerId);
    await db.batch([
      db.prepare("UPDATE owners SET disabled_at = NULL, disabled_reason = NULL WHERE id = ?").bind(ownerId),
      auditStatement(db, { at: now, actor: `admin:${c.get("admin")}`, action: "owner.enabled", siteId: null, detail: { ownerId } }),
    ]);
    return c.json({});
  });

  return sites;
}
