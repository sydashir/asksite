import type { GenerationView } from "@asksite/core";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";

const FAST_MS = 2_000;
const SLOW_MS = 10_000;
const FAST_FOR_MS = 120_000;

/**
 * Polls one generation until it is final (§3.1 step 4): every 2 s for the first 2 minutes,
 * then every 10 s. Plan 3 guarantees a final status within about 12 minutes.
 */
export function useGeneration(siteId: string, generationId: string | null) {
  const [generation, setGeneration] = useState<GenerationView | null>(null);
  const [slow, setSlow] = useState(false);
  const started = useRef(0);

  useEffect(() => {
    setGeneration(null);
    if (generationId === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    started.current = Date.now();
    setSlow(false);
    const poll = async () => {
      const res = await api<GenerationView>("GET", `/api/sites/${siteId}/generations/${generationId}`);
      if (stopped) return;
      if (res.ok) setGeneration(res.data);
      const final = res.ok && (res.data.status === "succeeded" || res.data.status === "failed");
      if (final) return;
      const elapsed = Date.now() - started.current;
      if (elapsed > FAST_FOR_MS) setSlow(true);
      timer = setTimeout(() => void poll(), elapsed > FAST_FOR_MS ? SLOW_MS : FAST_MS);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [siteId, generationId]);

  return { generation, slow };
}
