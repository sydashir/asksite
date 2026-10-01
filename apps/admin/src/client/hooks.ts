import { useCallback, useEffect, useState } from "react";
import { api, type ApiError } from "../../../app/src/client/lib/api.ts";

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
