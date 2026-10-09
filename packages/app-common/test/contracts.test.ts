import * as core from "@asksite/core";
import * as renderer from "@asksite/renderer";
import * as siteCss from "@asksite/site-css";
import * as schema from "@asksite/site-schema";
import { describe, expect, it } from "vitest";

// Plan 4 is built against Stage 0 (@asksite/core, @asksite/site-css, Plan 1 amendment A6) and
// Plan 1 exactly as the design names them (§2.3, §2.8, §4.2, §4.3, §11.1), plus Plan 2's additive
// `ipRateKey` (its decision 27) and amendment A12's page designs. If one of them lands with a
// different name, this fails first, with the missing names, instead of deep inside a route.
const USED = {
  core: [
    "AcceptInviteBody", "AiDraft", "ApproveBody", "AUDIT_ACTIONS", "Brief", "canonicalJson", "composeDocument", "CreateInviteBody",
    "DeleteOwnerBody", "DESIGN_FOR_TRADE", "designForTrade", "hashPages", "pageCacheUrl", "pagesDigest", "previewSiteUrl", "publicPageUrl", "versionPageKey", "VersionPages", "DisableOwnerBody", "documentSha256", "EMPTY_EDITS", "ERROR_STATUS", "formActionUrl", "hashIp",
    "IndexableBody", "ipRateKey", "isId", "LIMITS", "livePageKey", "livePointerKey", "liveSitePrefix", "LoginBody", "LOOKS", "mediaKey", "mediaUrl", "newId", "newToken",
    "OwnerEdits", "ownerEditedPaths", "PAGE_DESIGNS", "PatchDraftBody", "photoRefIssues", "previewFormActionUrl", "PublishBody",
    "RejectBody", "RESERVED_SLUGS", "SECTION_IDS", "SetSlugBody", "SettingsBody", "sha256Hex", "siteUrl", "slugIssue", "TakedownBody",
    "toIssues", "TOKEN_PATTERN", "TTL", "VerifyLoginBody", "versionKey",
  ],
  schema: [
    "COPY_LIMITS", "DAYS", "DEFAULT_DESIGN", "DESIGN_IDS", "Facts", "factSections", "HIDEABLE_SECTIONS", "isSafeUrl", "OwnerHidden",
    "SECTION_VARIANTS", "SiteDocument", "ThemeChoice", "ALWAYS_PAGES", "DEFAULT_SECTION_ORDER", "isPageId", "PAGE_IDS", "PAGES", "pageForPath", "QUOTE_HREF", "QUOTE_ID", "SECTION_PAGE",
  ],
  renderer: ["escapeAttr", "escapeText", "FONTS", "PALETTES", "pageTitle", "render", "sitePages"],
  siteCss: ["DESIGN_CSS"],
} as const;

const missing = (module: Record<string, unknown>, names: readonly string[]) => names.filter((name) => module[name] === undefined);

describe("contracts Plan 4 consumes", () => {
  it("every name exists", () => {
    expect(missing(core, USED.core)).toEqual([]);
    expect(missing(schema, USED.schema)).toEqual([]);
    expect(missing(renderer, USED.renderer)).toEqual([]);
    expect(missing(siteCss, USED.siteCss)).toEqual([]);
  });

  it("the values Plan 4 relies on match the design", () => {
    expect(core.SECTION_IDS[0]).toBe("hero");
    expect([...schema.HIDEABLE_SECTIONS]).toEqual(["trust", "testimonials", "gallery", "about", "serviceArea", "faq"]);
    expect(core.LOOKS.map((look) => look.id)).toEqual(["classic", "bright", "outdoor", "bold"]);
    expect(core.slugIssue("preview")).toBe("reserved");
    expect(core.ERROR_STATUS.email_failed).toBe(502);
    expect(core.LIMITS).toMatchObject({ uploadsPerSite: 40, uploadsPerSiteTotal: 150, loginTokensPerOwnerPerHour: 5, loginTokensPerOwnerPerDay: 10 });
    expect(core.TTL).toEqual({ inviteMs: 604_800_000, loginTokenMs: 900_000, sessionMs: 2_592_000_000 });
    expect(core.EMPTY_EDITS).toEqual({ baseGenerationId: null, copy: {}, order: null, hidden: [], theme: null });
    expect([core.ipRateKey("203.0.113.9"), core.ipRateKey("2001:db8:77:1::a")]).toEqual(["203.0.113.9", "2001:db8:77:1::/64"]);
    for (const id of schema.DESIGN_IDS) expect(siteCss.DESIGN_CSS[id].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the multi-page contract (A16): five pages, pointer keys, and liveKey is gone", () => {
    expect([...schema.PAGE_IDS]).toEqual(["home", "services", "about", "gallery", "contact"]);
    expect(schema.QUOTE_HREF).toBe("/contact#quote");
    expect(core).not.toHaveProperty("liveKey");
    const id = "11111111-1111-4111-8111-111111111111";
    expect(core.livePointerKey("joes")).toBe("joes");
    expect(core.livePageKey("joes", id, "about")).toBe(`joes/${id}/about.html`);
    expect(core.versionPageKey(id, id, "home")).toBe(core.versionKey(id, id));
    expect(core.versionPageKey(id, id, "gallery")).toBe(`versions/${id}/${id}/gallery.html`);
    expect(core.previewSiteUrl("localhost:8789", null)).toBe("https://preview.localhost:8789/");
  });

  it("the page designs, colour names and starting designs Plan 4 shows match A12", () => {
    expect(core.PAGE_DESIGNS.map(({ id, name }) => [id, name])).toEqual([
      ["impact", "Bold"],
      ["refined", "Classic"],
      ["modern", "Modern"],
    ]);
    expect(core.LOOKS.map((look) => look.name)).toEqual(["Navy & orange", "Blue & yellow", "Green & amber", "Charcoal & red"]);
    expect(core.DESIGN_FOR_TRADE).toEqual({ plumbing: "impact", hvac: "impact", electrical: "impact", roofing: "refined", landscaping: "refined", cleaning: "modern", it: "modern", law: "refined", other: "modern" });
  });

  it("SiteDocument accepts owner-hidden sections (A6) and still refuses hiding the hero", () => {
    expect(schema.OwnerHidden.safeParse(["faq"]).success).toBe(true);
    expect(schema.OwnerHidden.safeParse(["hero"]).success).toBe(false);
  });
});
