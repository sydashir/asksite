import { useEffect, useState } from "react";
import { onLinkClick } from "../../../app/src/client/hooks/use-route.ts";
import { matchAdminRoute, type AdminRoute } from "./lib/route.ts";
import { Invites } from "./pages/Invites.tsx";
import { NotFound } from "./pages/NotFound.tsx";
import { Queue } from "./pages/Queue.tsx";
import { Review } from "./pages/Review.tsx";
import { Settings } from "./pages/Settings.tsx";
import { SiteDetail } from "./pages/SiteDetail.tsx";
import { Sites } from "./pages/Sites.tsx";

function useAdminRoute(): AdminRoute {
  const [route, setRoute] = useState(() => matchAdminRoute(location.pathname));
  useEffect(() => {
    const update = () => setRoute(matchAdminRoute(location.pathname));
    window.addEventListener("popstate", update);
    window.addEventListener("asksite:navigate", update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("asksite:navigate", update);
    };
  }, []);
  return route;
}

function page(route: AdminRoute) {
  switch (route.name) {
    case "queue":
      return <Queue />;
    case "review":
      return <Review key={route.versionId} versionId={route.versionId} />;
    case "invites":
      return <Invites />;
    case "sites":
      return <Sites />;
    case "site":
      return <SiteDetail key={route.siteId} siteId={route.siteId} />;
    case "settings":
      return <Settings />;
    case "notFound":
      return <NotFound />;
  }
}

const NAV: ReadonlyArray<{ href: string; label: string; match: AdminRoute["name"][] }> = [
  { href: "/", label: "Review queue", match: ["queue", "review"] },
  { href: "/invites", label: "Invites", match: ["invites"] },
  { href: "/sites", label: "Sites", match: ["sites", "site"] },
  { href: "/settings", label: "Settings", match: ["settings"] },
];

export function App() {
  const route = useAdminRoute();
  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:rounded focus:bg-white focus:p-3">
        Skip to main content
      </a>
      <header className="border-b border-slate-300 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="text-lg font-bold">Admin</span>
          <nav aria-label="Admin">
            <ul className="flex flex-wrap gap-x-4 gap-y-1">
              {NAV.map((item) => (
                <li key={item.href}>
                  <a href={item.href} onClick={onLinkClick} className="link" aria-current={item.match.includes(route.name) ? "page" : undefined}>
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-6 break-words">
        {page(route)}
      </main>
    </>
  );
}
