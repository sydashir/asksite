import type { OwnerView, SiteSummary } from "@asksite/core";
import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";

/** GET /api/me's answer: the owner, their sites, and their password's state (routes/me.ts). */
interface Me {
  owner: OwnerView;
  sites: SiteSummary[];
  hasPassword: boolean;
  skipCurrent: boolean;
}

export type MeLoad = { state: "loading" } | { state: "signedOut" } | { state: "error"; message: string } | ({ state: "ready" } & Me);

/** The signed-in owner and their sites (GET /api/me), asked again whenever `refresh` changes. */
export function useMe(refresh: unknown = null): MeLoad {
  const [me, setMe] = useState<MeLoad>({ state: "loading" });
  useEffect(() => {
    let live = true;
    void api<Me>("GET", "/api/me").then((res) => {
      if (!live) return;
      if (res.ok) setMe({ state: "ready", ...res.data });
      else if (res.status === 401) setMe({ state: "signedOut" });
      else setMe({ state: "error", message: res.error.message });
    });
    return () => {
      live = false;
    };
  }, [refresh]);
  return me;
}
