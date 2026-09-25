/** Every audit_log.action value. */
export const AUDIT_ACTIONS = ["invite.created", "invite.revoked", "invite.accepted", "auth.login",
  "generation.requested", "version.requested", "version.withdrawn", "version.approved", "version.rejected",
  "site.taken_down", "site.restored", "site.indexable_changed", "owner.disabled", "owner.enabled",
  "settings.updated"] as const;
