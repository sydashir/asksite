/** The part of D1Database the claim uses, so a test can hand it the test database without the Worker's types. */
export interface ClaimDb {
  prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<{ meta: { changes: number } }> } };
}

/**
 * §5.2 step (1): claims an invite token by its hash. Exactly one claim wins: it changes the row only while the invite
 * is unused, not revoked and not expired, so a second claim of the same hash changes nothing and gives false. This
 * statement is the single gate for used, revoked and expired invites.
 */
export async function claimInvite(db: ClaimDb, tokenHash: string, now: number): Promise<boolean> {
  const claim = await db
    .prepare("UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?")
    .bind(now, tokenHash, now)
    .run();
  return claim.meta.changes === 1;
}
