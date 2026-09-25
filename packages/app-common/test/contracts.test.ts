import * as core from "@asksite/core";
import * as renderer from "@asksite/renderer";
import * as siteCss from "@asksite/site-css";
import * as schema from "@asksite/site-schema";
import { describe, expect, it } from "vitest";

// Plan 4 is built against Stage 0 (@asksite/core, @asksite/site-css, Plan 1 amendment A6) and
// Plan 1 exactly as the design names them (§2.3, §2.8, §4.2, §4.3, §11.1), plus Plan 2's additive
// `ipRateKey` (its decision 27). If one of them lands with a different name, this fails first, with
// the missing names, instead of deep inside a route.
const USED = {
  core: [
    "AcceptInviteBody", "AiDraft", "ApproveBody", "AUDIT_ACTIONS", "Brief", "canonicalJson", "composeDocument", "CreateInviteBody",
    "DisableOwnerBody", "documentSha256", "EMPTY_EDITS", "ERROR_STATUS", "formActionUrl", "hashIp", "IndexableBody", "ipRateKey", "isId",
    "LIMITS", "liveKey", "LoginBody", "LOOKS", "mediaKey", "mediaUrl", "newId", "newToken", "OwnerEdits", "ownerEditedPaths",
    "PatchDraftBody", "photoRefIssues", "previewFormActionUrl", "PublishBody", "RejectBody", "RESERVED_SLUGS", "SECTION_IDS",
    "SetSlugBody", "SettingsBody", "sha256Hex", "siteUrl", "slugIssue", "TakedownBody", "toIssues", "TOKEN_PATTERN", "TTL",
    "VerifyLoginBody", "versionKey",
  ],
  schema: ["COPY_LIMITS", "DAYS", "Facts", "factSections", "HIDEABLE_SECTIONS", "isSafeUrl", "OwnerHidden", "SECTION_VARIANTS", "SiteDocument"],
  renderer: ["escapeAttr", "escapeText", "FONTS", "PALETTES", "render"],
  siteCss: ["SITE_CSS", "SITE_CSS_SHA256"],
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
    expect(siteCss.SITE_CSS_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("SiteDocument accepts owner-hidden sections (A6) and still refuses hiding the hero", () => {
    expect(schema.OwnerHidden.safeParse(["faq"]).success).toBe(true);
    expect(schema.OwnerHidden.safeParse(["hero"]).success).toBe(false);
  });
});
