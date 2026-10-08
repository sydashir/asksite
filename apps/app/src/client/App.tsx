import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { Notice } from "./components/feedback.tsx";
import { useMe } from "./hooks/use-me.ts";
import { mayEndSession, onLinkClick, resetSignOutStop, useRoute } from "./hooks/use-route.ts";
import { api } from "./lib/api.ts";
import type { Route } from "./lib/route.ts";
import { AcceptInvite } from "./pages/AcceptInvite.tsx";
import { Build } from "./pages/Build.tsx";
import { Editor } from "./pages/Editor.tsx";
import { Home } from "./pages/Home.tsx";
import { Leads } from "./pages/Leads.tsx";
import { NotFound } from "./pages/NotFound.tsx";
import { Publish } from "./pages/Publish.tsx";
import { Questionnaire } from "./pages/Questionnaire.tsx";
import { VerifyLogin } from "./pages/VerifyLogin.tsx";

function page(route: Route) {
  switch (route.name) {
    case "home":
      return <Home />;
    case "invite":
      return <AcceptInvite />;
    case "login":
      return <VerifyLogin />;
    case "setup":
      return <Questionnaire key={`${route.siteId}-${route.step}`} siteId={route.siteId} step={route.step} />;
    case "build":
      return <Build key={route.siteId} siteId={route.siteId} />;
    case "edit":
      return <Editor key={route.siteId} siteId={route.siteId} />;
    case "publish":
      return <Publish key={route.siteId} siteId={route.siteId} />;
    case "leads":
      return <Leads key={route.siteId} siteId={route.siteId} />;
    case "notFound":
      return <NotFound />;
  }
}

const SIGN_OUT_FAILED = "We could not sign you out. Check your connection and try again.";

/** Saves what the page holds, then ends the session and reloads so no signed-in state survives in memory. A press that waits says "Saving…"; anything unsaved stops it once, with the reason (mayEndSession); the next press goes on. */
async function signOut(say: (message: string | null) => void) {
  if (!(await mayEndSession(say))) return;
  // Leave only once the server ended the session (204): a failed logout leaves it alive, so stay and say so (the next press tries again).
  const res = await api("POST", "/api/auth/logout");
  if (!res.ok) {
    // The same words as the last failure: clear the alert (rendered now, not batched with the next line), then set it, so it is announced again.
    flushSync(() => say(null));
    say(SIGN_OUT_FAILED);
    return;
  }
  location.assign("/");
}

export function App() {
  const route = useRoute();
  // Asked again for every kind of page, so "Sign out" shows once signed in and never on the sign-in page.
  const me = useMe(route.name);
  // Why Sign out stopped (it stops once): said here, whatever page is on screen.
  const [stopMessage, setStopMessage] = useState<string | null>(null);
  useEffect(() => {
    setStopMessage(null);
    resetSignOutStop();
  }, [route]);
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <header className="surface-dark border-b border-white/10">
        <div className="mx-auto flex min-h-16 max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-2.5">
          {/* The mark is decorative here: the link's name stays "Your website". */}
          <a href="/" onClick={onLinkClick} className="brand-link">
            <img src="/hybrid.png" alt="" width={40} height={40} className="brand-mark" />
            Your website
          </a>
          {me.state === "ready" ? (
            <button type="button" className="btn-on-dark" onClick={() => void signOut(setStopMessage)}>
              Sign out
            </button>
          ) : null}
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-8 break-words sm:py-10">
        {stopMessage !== null ? (
          <div role="alert">
            <Notice tone="error">{stopMessage}</Notice>
          </div>
        ) : null}
        {page(route)}
      </main>
      {/* The same help in the same place on every page (WCAG 3.2.6); "Contact us" messages point here. */}
      <footer className="mx-auto max-w-6xl border-t border-slate-200 px-4 pt-6 pb-10 text-sm text-slate-700">
        Questions? Email{" "}
        <a className="link break-all" href={`mailto:${__SUPPORT_EMAIL__}`}>
          {__SUPPORT_EMAIL__}
        </a>
      </footer>
    </>
  );
}
