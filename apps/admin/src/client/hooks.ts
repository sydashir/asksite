import type { AdminVersionDetail } from "@asksite/core";
import type { PageId } from "@asksite/site-schema";
import { useCallback, useEffect, useState } from "react";
import { api, type ApiError } from "../../../app/src/client/lib/api.ts";
import { verifiedHtml } from "./lib/verified-page.ts";

export type Load<T> = { state: "loading" } | { state: "error"; error: ApiError } | { state: "ready"; data: T };

/** GET a JSON resource; `reload` fetches it again. */
export function useResource<T>(path: string) {
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });
  const reload = useCallback(async () => {
    const res = await api<T>("GET", path);
    setLoad(res.ok ? { state: "ready", data: res.data } : { state: "error", error: res.error });
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { load, reload };
}

/**
 * Every stored page of a version, fetched as RAW bytes and proved against the page's own listed sha256 before any of it can be
 * shown. "error": a page request failed (network or HTTP). "mismatch": a page's bytes do not hash to its listed sha256, are not
 * valid UTF-8, or cannot be checked at all (any throw, a missing crypto.subtle included): `label` names the first such page.
 * Only "ready" carries html, and it is exactly the hashed bytes. `retry` fetches and proves everything again.
 */
export type VerifiedPages =
  | { state: "loading" }
  | { state: "error" }
  | { state: "mismatch"; label: string }
  | { state: "ready"; sources: Array<{ page: PageId; html: string }> };

export function useVerifiedPages(pages: AdminVersionDetail["pages"]): { verified: VerifiedPages; retry: () => void } {
  const [verified, setVerified] = useState<VerifiedPages>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  // A reload of the review (after an approve, say) gives new objects with the same pages: fetch again only when a page, its address or its hash changes.
  const key = pages.map((p) => `${p.page}:${p.url}:${p.sha256}`).join("|");
  useEffect(() => {
    let live = true;
    setVerified({ state: "loading" });
    void (async (): Promise<VerifiedPages> => {
      let fetched: Array<{ page: AdminVersionDetail["pages"][number]; bytes: ArrayBuffer }>;
      try {
        fetched = await Promise.all(
          pages.map(async (page) => {
            const res = await fetch(page.url, { credentials: "same-origin" });
            if (!res.ok) throw new Error("page request failed");
            return { page, bytes: await res.arrayBuffer() };
          }),
        );
      } catch {
        return { state: "error" };
      }
      const sources: Array<{ page: PageId; html: string }> = [];
      for (const { page, bytes } of fetched) {
        // Each page against ITS OWN hash. Any throw fails closed, as a mismatch.
        const html = await verifiedHtml(bytes, page.sha256).catch(() => null);
        if (html === null) return { state: "mismatch", label: page.label };
        sources.push({ page: page.page, html });
      }
      return { state: "ready", sources };
    })().then((result) => live && setVerified(result));
    return () => {
      live = false;
    };
  }, [key, attempt]);
  return { verified, retry: () => setAttempt((n) => n + 1) };
}
