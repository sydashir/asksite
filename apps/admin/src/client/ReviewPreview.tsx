import { useEffect, useState } from "react";
import { Notice } from "../../../app/src/client/components/feedback.tsx";
import { withLinksOff } from "./lib/preview.ts";

type Load = { state: "loading" } | { state: "error" } | { state: "ready"; html: string };

/**
 * One page of a site, as stored, in a sandboxed srcdoc frame. `src` is the admin API address of the stored page: the frame is
 * never navigated to it (the admin's Fetch-Metadata gate refuses a cross-site re-request, P4-18b); it is fetched same-origin and the
 * bytes shown. The frame has no allow-scripts, allow-forms, allow-same-origin or allow-top-navigation, and its links are turned
 * off. A site with several pages shows one ReviewPreview per page.
 */
export function ReviewPreview({ src, phone }: { src: string; phone: boolean }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setLoad({ state: "loading" });
    fetch(src, { credentials: "same-origin" })
      .then(async (res) => {
        if (!res.ok) throw new Error("page request failed");
        return res.text();
      })
      .then(
        (html) => live && setLoad({ state: "ready", html }),
        () => live && setLoad({ state: "error" }),
      );
    return () => {
      live = false;
    };
  }, [src, attempt]);

  const size = phone ? "h-[80vh] w-[390px] max-w-full" : "h-[80vh] w-full";
  // The placeholder is as tall as the frame, so the buttons below it do not jump when the page arrives.
  if (load.state === "loading") {
    return (
      <>
        <p role="status" className={`mt-3 ${size}`}>
          Loading the page…
        </p>
      </>
    );
  }
  if (load.state === "error") {
    return (
      <div role="alert">
        <Notice tone="error">The page couldn't load.</Notice>
        <button type="button" className="btn-secondary mt-3" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  }
  return (
    <>
      <iframe
        title="Page under review"
        sandbox=""
        srcDoc={withLinksOff(load.html)}
        className={`mt-3 rounded-lg border border-slate-400 bg-white ${size}`}
      />
    </>
  );
}
