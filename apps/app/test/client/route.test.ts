import { describe, expect, it } from "vitest";
import { matchRoute, nextStep, paths, previousStep } from "../../src/client/lib/route.ts";

const ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";

describe("matchRoute", () => {
  it.each([
    ["/", { name: "home" }],
    ["/invite", { name: "invite" }],
    ["/login", { name: "login" }],
    ["/signup", { name: "signup" }],
    [`/sites/${ID}/setup/business`, { name: "setup", siteId: ID, step: "business" }],
    [`/sites/${ID}/setup/address`, { name: "setup", siteId: ID, step: "address" }],
    [`/sites/${ID}/build`, { name: "build", siteId: ID }],
    [`/sites/${ID}/edit`, { name: "edit", siteId: ID }],
    [`/sites/${ID}/publish`, { name: "publish", siteId: ID }],
    [`/sites/${ID}/leads`, { name: "leads", siteId: ID }],
  ])("%s", (path, route) => {
    expect(matchRoute(path)).toEqual(route);
  });

  it.each(["/nope", `/sites/${ID}/setup/unknown`, "/sites/not-an-id/edit", `/sites/${ID}/edit/extra`, "/invite/", "/signup/", "/login/"])("%s is not found", (path) => {
    expect(matchRoute(path)).toEqual({ name: "notFound" });
  });

  it("round-trips every path helper", () => {
    expect(matchRoute(paths.signup())).toEqual({ name: "signup" });
    expect(matchRoute(paths.login())).toEqual({ name: "login" });
    expect(matchRoute(paths.edit(ID))).toEqual({ name: "edit", siteId: ID });
    expect(matchRoute(paths.setup(ID, "trust"))).toEqual({ name: "setup", siteId: ID, step: "trust" });
  });
});

describe("step order", () => {
  it("walks the seven questionnaire steps", () => {
    expect(nextStep("business")).toBe("services");
    expect(nextStep("address")).toBeNull();
    expect(previousStep("business")).toBeNull();
    expect(previousStep("address")).toBe("words");
  });
});
