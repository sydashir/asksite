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
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-20 focus:rounded-lg focus:bg-brand-500 focus:px-4 focus:py-3 focus:font-semibold focus:text-ink">
        Skip to main content
      </a>
      <header className="surface-dark border-b border-white/10">
        <div className="mx-auto flex min-h-16 max-w-6xl flex-wrap items-center gap-x-8 gap-y-1 px-4 py-2.5">
          <span className="inline-flex items-center gap-3 text-[1.0625rem] font-semibold tracking-[-0.01em]">
            <img src="/hybrid.png" alt="Hybrid Mediaworks" width={40} height={40} className="size-10 rounded-[10px]" />
            <span className="border-l border-white/20 pl-3">Admin</span>
          </span>
          <nav aria-label="Admin" className="-mx-2.5 w-full sm:mx-0 sm:w-auto">
            <ul className="flex flex-wrap gap-x-1">
              {NAV.map((item) => (
                <li key={item.href}>
                  <a href={item.href} onClick={onLinkClick} className="nav-link" aria-current={item.match.includes(route.name) ? "page" : undefined}>
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-8 break-words sm:py-10">
        {page(route)}
      </main>
    </>
  );
}
