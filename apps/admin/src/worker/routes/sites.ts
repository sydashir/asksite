import { ApiError, auditStatement, cleanOwnerText, logLine, readJson, runToEnd, siteNoticeEmail, trySend } from "@asksite/app-common";
import { DeleteOwnerBody, DisableOwnerBody, IndexableBody, isId, TakedownBody, type AuditRow, type GenerationRow, type SiteVersionRow } from "@asksite/core";
import { Hono } from "hono";
import { z } from "zod";
import { CONFIRM_EMAIL_MISMATCH, OWNER_DELETION_STARTED, OWNER_NOT_DISABLED, RESTORED_SINCE_OPENED, TAKEN_DOWN_SINCE_OPENED } from "../../messages.ts";
import type { OwnerDeletionView, TakedownView } from "../../settings-view.ts";
import { mailerEnv, siteWithOwner, toAdminSiteRow, toVersionSummary, type AdminSiteColumns } from "../db.ts";
import type { AdminDeps, PublishErrorLike } from "../deps.ts";
import { publishApiError, type PublishAction } from "../publish-errors.ts";
import { GENERATION_HISTORY, SITE_AUDIT, SITE_LAST_RESTORED, SITE_LIST, SITE_LIST_TAIL, VERSION_HISTORY } from "../queries.ts";
import type { AdminEnv } from "../types.ts";

const FILTERS = {
  live: "s.live_version_id IS NOT NULL AND s.taken_down_at IS NULL",
  in_review: "s.pending_version_id IS NOT NULL",
  taken_down: "s.taken_down_at IS NOT NULL",
  draft: "s.live_version_id IS NULL AND s.pending_version_id IS NULL AND s.taken_down_at IS NULL",
  all: "1 = 1",
} as const;

/**
 * The takedown body, plus the state the admin's page showed, extended here and not in core. Finish the takedown sends expectedTakenDownAt (the moment
 * its form was opened for). The up-site form sends expectedRestoredAt: the newest site.restored moment its page showed, null when never restored.
 */
const StatefulTakedownBody = TakedownBody.extend({ expectedTakenDownAt: z.number().int().positive().optional(), expectedRestoredAt: z.number().int().positive().nullable().optional() });

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
    const [versions, generations, leads, audit, restored, ownerSites] = await Promise.all([
      db.prepare(VERSION_HISTORY).bind(site.id).all<Pick<SiteVersionRow, "id" | "number" | "status" | "requested_at" | "reviewed_at" | "review_note">>(),
      db.prepare(GENERATION_HISTORY).bind(site.id).all<GenerationRow>(),
      db.prepare("SELECT COUNT(*) AS n FROM leads WHERE site_id = ?").bind(site.id).first<{ n: number }>(),
      db.prepare(SITE_AUDIT).bind(site.id).all<Pick<AuditRow, "at" | "actor" | "action" | "detail_json">>(),
      db.prepare(SITE_LAST_RESTORED).bind(site.id).first<{ at: number | null }>(),
      // How many sites Delete the account would delete with this one (sites_owner index): the confirmation dialog says so.
      db.prepare("SELECT COUNT(*) AS n FROM sites WHERE owner_id = ?").bind(site.owner_id).first<{ n: number }>(),
    ]);
    return c.json({
      site: toAdminSiteRow(site),
      // The moment the takedown happened, which Restore must send back (A16-4c): a restore refuses a different takedown. AdminSiteRow (core) has no field for it.
      takenDownAt: site.taken_down_at,
      // The newest moment the site came back up (null: never restored), read by the server so it never depends on the 100-row audit list below. The up-site take-down form is keyed by it and sends it back.
      restoredAt: restored?.at ?? null,
      versions: versions.results.map(toVersionSummary),
      generations: generations.results.map((g) => ({
        ...deps.generation.toGenerationView(g),
        provider: g.provider,
        model: g.model,
        costMicrousd: g.cost_microusd,
        modelSlot: g.model_slot,
        attempts: g.attempts,
      })),
      leadCount: leads?.n ?? 0,
      ownerSites: ownerSites?.n ?? 0,
      audit: audit.results.map((a) => ({ at: a.at, actor: a.actor, action: a.action, detail: a.detail_json === null ? null : JSON.parse(a.detail_json) })),
    });
  });

  sites.post("/sites/:siteId/takedown", async (c) => {
    const body = await readJson(c, StatefulTakedownBody);
    const site = await siteWithOwner(c.env.DB, c.req.param("siteId"));
    // A Finish names the takedown its page showed. If the site is not down at EXACTLY that moment (restored, or taken down again, since),
    // refuse before takeDown: this call would take a restored site down again and email the owner. Residual: a restore that lands between
    // this check and takeDown's own lease (milliseconds) is not caught, because Plan 2's takeDown has no expected-moment check.
    if (body.expectedTakenDownAt !== undefined && site.taken_down_at !== body.expectedTakenDownAt) throw new ApiError("conflict", RESTORED_SINCE_OPENED);
    // The up-site form names the state its page showed (a site that was up, last restored at expectedRestoredAt). A site that is down now, or was restored since,
    // is another state: refuse before takeDown, which would otherwise treat a stale press on a down site as a re-run with THIS body's purge choice, or email a restored site's owner.
    // Residual: the window runs from the site read above to takeDown's own lease (milliseconds), and Plan 2's takeDown has no expected-state check. If another admin's WHOLE
    // takedown (lease, commit, release) fits inside it, this press runs as a re-run with THIS body's purge choice on that takedown, and this call's owner message is dropped.
    // A press that overlaps the other admin's lease gets SITE_BUSY instead.
    if (body.expectedRestoredAt !== undefined) {
      if (site.taken_down_at !== null) throw new ApiError("conflict", TAKEN_DOWN_SINCE_OPENED);
      const restored = await c.env.DB.prepare(SITE_LAST_RESTORED).bind(site.id).first<{ at: number | null }>();
      if ((restored?.at ?? null) !== body.expectedRestoredAt) throw new ApiError("conflict", RESTORED_SINCE_OPENED);
    }
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
            // The takedown's stored moment decides who took the site down. If the read fails, fall back to the read made before takeDown, but only
            // when takeDown RETURNED (its commit is certain). A takeDown that threw lease_lost may have stopped before its commit, and a takedown
            // notice for a site that is still up is untrue and cannot be undone, so then nothing is sent and the 409 says the owner was not told.
            const stored = await storedTakedownAt(c.env.DB, site.id);
            const rereadFailed = stored === undefined;
            const tookItDown = rereadFailed ? !alreadyDown && leaseLost === null : stored !== null && stamps.includes(stored);
            // The key names the takedown (its stored moment), so every call that sends the notice for it is the same message to the mail provider.
            const send = () => trySend(mailer, { to: site.owner_email, ...email, replyTo: c.env.SUPPORT_EMAIL, tag: "site_notice", idempotencyKey: `takedown:${site.id}:${stored ?? site.taken_down_at ?? now}` });
            // A lost lease: tell the owner if THIS call took the site down (the re-read decides; a failed re-read sends nothing), then answer
            // the 409 with the notice's outcome as noticeSent (true sent, false failed, null this call sent none), so the admin knows whether the owner was told.
            // A failed re-read on a site that was up leaves it UNKNOWN whether this call took the site down: noticeSent null plus noticeUnknown true, never false.
            if (leaseLost !== null) {
              const unknown = !tookItDown && rereadFailed && !alreadyDown;
              const noticeSent = tookItDown ? await send() : null;
              const mapped = publishApiError((leaseLost as PublishErrorLike).code, "takedown", (leaseLost as PublishErrorLike).detail);
              throw mapped === null ? leaseLost : new ApiError(mapped.code, mapped.message, { ...mapped.extra, noticeSent, ...(unknown ? { noticeUnknown: true as const } : {}) });
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

  /** 404 for an unknown owner before anything is written, so a refused change leaves no audit row. Only Delete the account removes an owner, and it removes the row. */
  async function knownOwner(db: D1Database, ownerId: string): Promise<void> {
    const owner = await db.prepare("SELECT 1 AS found FROM owners WHERE id = ?").bind(ownerId).first();
    if (owner === null) throw new ApiError("not_found", "Not found");
  }

  /** The owner's account deletion has started (an owner.deletion_started row names it): same shape as deleteOwner's own read of it. */
  const DELETION_STARTED = "SELECT 1 AS found FROM audit_log WHERE action = 'owner.deletion_started' AND site_id IS NULL AND json_extract(detail_json, '$.ownerId') = ?";

  /** A started deletion refuses enable and disable (409): the owner is half deleted, and only Delete the account finishes it. */
  async function refuseIfDeletionStarted(db: D1Database, ownerId: string): Promise<void> {
    if ((await db.prepare(`${DELETION_STARTED} LIMIT 1`).bind(ownerId).first()) !== null) throw new ApiError("conflict", OWNER_DELETION_STARTED);
  }

  /** The audit row of an owner change, written only when the statement right before it in the batch changed a row (the auditIfChanged pattern of @asksite/publishing). */
  function auditIfChanged(db: D1Database, entry: { at: number; actor: string; action: "owner.disabled" | "owner.enabled"; detail: Record<string, unknown> }): D1PreparedStatement {
    return db
      .prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) SELECT ?, ?, ?, NULL, ? WHERE changes() = 1")
      .bind(entry.at, entry.actor, entry.action, JSON.stringify(entry.detail));
  }

  /** The fence both owner changes carry (ruling Q-1): a started deletion changes nothing, even when it starts after the route's own check. */
  const NO_DELETION_STARTED = `NOT EXISTS (${DELETION_STARTED})`;

  /**
   * After the fenced UPDATE of enable or disable. It changed a row: done. It changed none: a 409 when a deletion started (the race with the pre-check,
   * ruling Q-1), else the owner was already in the state asked for (idempotence: the first values stay, no second audit row), which is done too, a 200.
   */
  async function refuseWhenUnchanged(db: D1Database, ownerId: string, changed: number | undefined): Promise<void> {
    if (changed !== 1) await refuseIfDeletionStarted(db, ownerId);
  }

  sites.post("/owners/:ownerId/disable", async (c) => {
    const { reason } = await readJson(c, DisableOwnerBody);
    const ownerId = c.req.param("ownerId");
    const db = c.env.DB;
    const now = Date.now();
    await knownOwner(db, ownerId);
    await refuseIfDeletionStarted(db, ownerId);
    // Order matters. The audit INSERT sits IMMEDIATELY after the UPDATE: its `changes() = 1` reads the row count of "the most recently completed INSERT, DELETE,
    // or UPDATE statement" (https://www.sqlite.org/lang_corefunc.html#changes), so the sessions DELETE comes AFTER it, never between the two.
    // An owner who is already disabled changes no row, so the first reason and time stay and no second owner.disabled row appears.
    const results = await db.batch([
      db
        .prepare(`UPDATE owners SET disabled_at = ?, disabled_reason = ? WHERE id = ? AND disabled_at IS NULL AND ${NO_DELETION_STARTED}`)
        .bind(now, reason, ownerId, ownerId),
      auditIfChanged(db, { at: now, actor: `admin:${c.get("admin")}`, action: "owner.disabled", detail: { ownerId, reason } }),
      db.prepare("DELETE FROM sessions WHERE owner_id = ?").bind(ownerId),
    ]);
    await refuseWhenUnchanged(db, ownerId, results[0]?.meta.changes);
    return c.json({});
  });

  sites.post("/owners/:ownerId/enable", async (c) => {
    await readJson(c, z.strictObject({}));
    const ownerId = c.req.param("ownerId");
    const db = c.env.DB;
    const now = Date.now();
    await knownOwner(db, ownerId);
    await refuseIfDeletionStarted(db, ownerId);
    // As disable: the audit INSERT directly after the UPDATE (https://www.sqlite.org/lang_corefunc.html#changes: changes() is the count of "the most recently
    // completed INSERT, DELETE, or UPDATE statement"). An owner who is already enabled changes no row and adds no owner.enabled row.
    const results = await db.batch([
      db.prepare(`UPDATE owners SET disabled_at = NULL, disabled_reason = NULL WHERE id = ? AND disabled_at IS NOT NULL AND ${NO_DELETION_STARTED}`).bind(ownerId, ownerId),
      auditIfChanged(db, { at: now, actor: `admin:${c.get("admin")}`, action: "owner.enabled", detail: { ownerId } }),
    ]);
    await refuseWhenUnchanged(db, ownerId, results[0]?.meta.changes);
    return c.json({});
  });

  // Delete the account (spec §7.7): the owner must be disabled, and the admin types the owner's email back. The deletion is Part 1's deleteOwner; it takes the lease
  // of every site, so it runs to its end under waitUntil like the takedown. The email is in the body only, and no log line holds it (the request line is the route pattern and status).
  sites.post("/owners/:ownerId/delete", async (c) => {
    const { confirmEmail } = await readJson(c, DeleteOwnerBody);
    const ownerId = c.req.param("ownerId");
    if (!isId(ownerId)) throw new ApiError("not_found", "Not found");
    const result = await publishing(
      () => runToEnd(c.executionCtx, deps.publishing.deleteOwner(c.env, { ownerId, confirmEmail, reviewer: c.get("admin"), now: Date.now() })),
      "delete_owner",
    );
    switch (result.outcome) {
      case "deleted":
        return c.json({ deleted: true, alreadyDeleted: false, counts: result.counts } satisfies OwnerDeletionView);
      case "already_deleted":
        return c.json({ deleted: true, alreadyDeleted: true, counts: null } satisfies OwnerDeletionView);
      case "not_found":
        throw new ApiError("not_found", "Not found");
      case "not_disabled":
        throw new ApiError("conflict", OWNER_NOT_DISABLED);
      case "email_mismatch":
        throw new ApiError("validation_failed", CONFIRM_EMAIL_MISMATCH, { issues: [{ path: ["confirmEmail"], code: "email_mismatch", message: CONFIRM_EMAIL_MISMATCH }] });
    }
  });

  return sites;
}
