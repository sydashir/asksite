import type { GenerationView, SiteView } from "@asksite/core";
import { useEffect, useState } from "react";
import { Notice } from "../components/feedback.tsx";
import { useGeneration } from "../hooks/use-generation.ts";
import { usePageHeading } from "../hooks/use-page-heading.ts";
import { navigate } from "../hooks/use-route.ts";
import { api } from "../lib/api.ts";
import { paths } from "../lib/route.ts";

/** How often the first load is tried before the owner is told, and the pause between tries. */
const LOAD_ATTEMPTS = 3;
const RETRY_MS = 1_000;

/** Progress while the first draft is written (§3.1 step 4). */
export function Build({ siteId }: { siteId: string }) {
  const heading = usePageHeading<HTMLHeadingElement>("Building your website");
  const [generationId, setGenerationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);
  const { generation, slow } = useGeneration(siteId, generationId);

  useEffect(() => {
    let stopped = false;
    void (async () => {
      for (let attempt = 1; ; attempt++) {
        const res = await api<SiteView>("GET", `/api/sites/${siteId}`);
        if (stopped) return;
        if (res.ok) {
          if (res.data.activeGeneration !== null) setGenerationId(res.data.activeGeneration.id);
          else if (res.data.ai !== null) navigate(paths.edit(siteId), { replace: true });
          // No draft and nothing running: a first build that failed (or never started). The last step holds "Build my website".
          else navigate(paths.setup(siteId, "address"), { replace: true });
          return;
        }
        // A dropped connection or a server error is often gone a moment later, so it is tried again
        // quietly (the progress polls do the same); anything else, or a lasting failure, is shown.
        const passing = res.status === 0 || res.status >= 500;
        if (!passing || attempt === LOAD_ATTEMPTS) {
          setError(res.error.message);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
        if (stopped) return;
      }
    })();
    return () => {
      stopped = true;
    };
  }, [siteId, loads]);

  function loadAgain() {
    setError(null);
    setLoads((n) => n + 1);
  }

  useEffect(() => {
    if (generation?.status === "succeeded") navigate(paths.edit(siteId), { replace: true });
  }, [generation, siteId]);

  async function retry() {
    setError(null);
    // The FIRST build again (handoff 2b, DECIDED): if a draft landed meanwhile (another tab), the server answers generation_in_progress
    // instead of rewriting it, and the page loads again, which opens the editor (or follows a build that is running).
    const res = await api<{ generation: GenerationView }>("POST", `/api/sites/${siteId}/generations`, { kind: "first" });
    if (res.ok) setGenerationId(res.data.generation.id);
    else if (res.error.code === "generation_in_progress") loadAgain();
    else setError(res.error.message);
  }

  const failed = generation?.status === "failed";
  return (
    <section className="card mx-auto mt-2 max-w-xl sm:mt-6 sm:p-8">
      <span className="icon-tile" aria-hidden="true">
        <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      </span>
      <h1 ref={heading} tabIndex={-1} className="page-title mt-5">
        Building your website
      </h1>
      <p role="status" className="mt-3 text-lg text-slate-700">
        {failed
          ? "Something went wrong while writing your website."
          : slow
            ? "Still working… This can take a few minutes. You can close this page and come back later."
            : "We are writing your website. This usually takes under a minute."}
      </p>
      {/* Decorative: the status line above says what is happening. */}
      {failed || error !== null ? null : <div className="progress-indeterminate mt-6" aria-hidden="true" />}
      {failed ? (
        <button type="button" className="btn-primary mt-6" onClick={() => void retry()}>
          Try again
        </button>
      ) : null}
      {error !== null ? (
        <div role="alert">
          <Notice tone="error">{error}</Notice>
          {generationId === null ? (
            <button type="button" className="btn-secondary mt-3" onClick={loadAgain}>
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
