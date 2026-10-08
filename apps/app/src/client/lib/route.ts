// The owner app's pages (8 at most, §11.2). No router library: paths are matched here and the
// History API does the rest (hooks/use-route.ts).

export const STEPS = ["business", "services", "area", "trust", "photos", "words", "address"] as const;
export type StepId = (typeof STEPS)[number];

export type Route =
  | { name: "home" }
  | { name: "invite" }
  | { name: "login" }
  | { name: "setup"; siteId: string; step: StepId }
  | { name: "build"; siteId: string }
  | { name: "edit"; siteId: string }
  | { name: "publish"; siteId: string }
  | { name: "leads"; siteId: string }
  | { name: "notFound" };

const SITE = "([0-9a-f-]{36})";

export function matchRoute(pathname: string): Route {
  if (pathname === "/") return { name: "home" };
  if (pathname === "/invite") return { name: "invite" };
  if (pathname === "/login") return { name: "login" };
  const setup = new RegExp(`^/sites/${SITE}/setup/([a-z]+)$`).exec(pathname);
  if (setup?.[1] !== undefined && setup[2] !== undefined && (STEPS as readonly string[]).includes(setup[2])) {
    return { name: "setup", siteId: setup[1], step: setup[2] as StepId };
  }
  const page = new RegExp(`^/sites/${SITE}/(build|edit|publish|leads)$`).exec(pathname);
  if (page?.[1] !== undefined && page[2] !== undefined) {
    return { name: page[2] as "build" | "edit" | "publish" | "leads", siteId: page[1] };
  }
  return { name: "notFound" };
}

export const paths = {
  home: () => "/",
  setup: (siteId: string, step: StepId) => `/sites/${siteId}/setup/${step}`,
  build: (siteId: string) => `/sites/${siteId}/build`,
  edit: (siteId: string) => `/sites/${siteId}/edit`,
  publish: (siteId: string) => `/sites/${siteId}/publish`,
  leads: (siteId: string) => `/sites/${siteId}/leads`,
};

export function nextStep(step: StepId): StepId | null {
  return STEPS[STEPS.indexOf(step) + 1] ?? null;
}

export function previousStep(step: StepId): StepId | null {
  return STEPS[STEPS.indexOf(step) - 1] ?? null;
}
