/**
 * Every audit_log.action value. Append-only (A14): audit_log.action has no SQL CHECK (0001_init.sql), so a new action
 * needs no migration and stored rows keep their meaning.
 */
export const AUDIT_ACTIONS = ["invite.created", "invite.revoked", "invite.accepted", "auth.login",
  "generation.requested", "version.requested", "version.withdrawn", "version.approved", "version.rejected",
  "site.taken_down", "site.restored", "site.indexable_changed", "owner.disabled", "owner.enabled",
  "settings.updated", "admin.login_link_sent"] as const;
