import { useMe } from "./hooks/use-me.ts";
import { onLinkClick, useRoute } from "./hooks/use-route.ts";
import { api } from "./lib/api.ts";
import type { Route } from "./lib/route.ts";
import { AcceptInvite } from "./pages/AcceptInvite.tsx";
import { Build } from "./pages/Build.tsx";
import { Home } from "./pages/Home.tsx";
import { NotFound } from "./pages/NotFound.tsx";
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
    case "publish":
    case "leads":
    case "notFound":
      return <NotFound />;
  }
}

/** Ends the session, then reloads so no signed-in state survives in memory. */
async function signOut() {
  await api("POST", "/api/auth/logout");
  location.assign("/");
}

export function App() {
  const route = useRoute();
  // Asked again for every kind of page, so "Sign out" shows once signed in and never on the sign-in page.
  const me = useMe(route.name);
  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:rounded focus:bg-white focus:p-3">
        Skip to main content
      </a>
      <header className="border-b border-slate-300 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <a href="/" onClick={onLinkClick} className="text-lg font-bold text-slate-900">
            Your website
          </a>
          {me.state === "ready" ? (
            <button type="button" className="btn-secondary" onClick={() => void signOut()}>
              Sign out
            </button>
          ) : null}
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-6 break-words">
        {page(route)}
      </main>
      {/* The same help in the same place on every page (WCAG 3.2.6); "Contact us" messages point here. */}
      <footer className="mx-auto max-w-6xl px-4 pb-8 text-sm text-slate-700">
        Questions? Email{" "}
        <a className="link break-all" href={`mailto:${__SUPPORT_EMAIL__}`}>
          {__SUPPORT_EMAIL__}
        </a>
      </footer>
    </>
  );
}
