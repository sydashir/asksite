import { z } from "zod";
import { OwnerEditsBody } from "./draft.ts";
import { TOKEN_PATTERN } from "./tokens.ts";

// Request bodies of the owner and admin APIs (design §4.3). Emails are trimmed before the email
// check (A9: z.email() alone refuses surrounding spaces) and lower-cased before use; a body that
// fails its schema gets 422 validation_failed with issues.

const Token = z.string().regex(TOKEN_PATTERN);
const Rev = z.int().min(1);
const Json = z.record(z.string(), z.unknown());
const Email = z.string().trim().pipe(z.email().max(254));
export const AcceptInviteBody = z.strictObject({ token: Token });
export const LoginBody = z.strictObject({ email: Email });
export const VerifyLoginBody = z.strictObject({ token: Token });
export const PatchDraftBody = z
  .strictObject({ rev: Rev, facts: Json.optional(), brief: Json.optional(), edits: OwnerEditsBody.optional() })
  .refine((b) => b.facts !== undefined || b.brief !== undefined || b.edits !== undefined, { error: "Nothing to save" });
export const SetSlugBody = z.strictObject({ rev: Rev, slug: z.string().max(40) });
export const PublishBody = z.strictObject({ rev: Rev });
export const CreateInviteBody = z.strictObject({ email: Email }); // always emailed
export const ApproveBody = z.strictObject({
  htmlSha256: z.string().regex(/^[0-9a-f]{64}$/), // the version's html_sha256 as shown to the admin
  note: z.string().trim().max(1000).optional(),
  indexable: z.boolean().default(true),
});
export const RejectBody = z.strictObject({ note: z.string().trim().min(1).max(1000) });
export const TakedownBody = z.strictObject({
  reason: z.string().trim().min(1).max(1000),
  ownerMessage: z.string().trim().max(1000).optional(),
  purgeMedia: z.boolean().default(false),
});
export const IndexableBody = z.strictObject({ indexable: z.boolean() });
export const DisableOwnerBody = z.strictObject({ reason: z.string().trim().min(1).max(1000) });
export const SettingsBody = z.strictObject({
  generationEnabled: z.boolean().optional(),
  dailyModelLimit: z.int().min(0).max(1000).optional(),
});
