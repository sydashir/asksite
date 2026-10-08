/**
 * The per-network limit on self-serve sign-ups: one audit_log row per sign-in or sign-up request that passed Turnstile
 * (I3: the owner's rows come from NETWORK_ROW_SQL), and a sign-up writes its row only while the network has fewer than ?4
 * rows today, counted in the same statement. ?1 now, ?2 the detail ({ ipHash }), ?3 the UTC day's start. The count reads
 * the audit_site (site_id, at) index (signup.workerd.test.ts checks the query plan). Its own module, with no Worker types,
 * so that test can import it.
 */
export const NETWORK_SIGNUP_SQL = `INSERT INTO audit_log (at, actor, action, site_id, detail_json)
  SELECT ?1, 'signup', 'owner.signup_requested', NULL, ?2
  WHERE (SELECT COUNT(*) FROM audit_log WHERE site_id IS NULL AND at >= ?3 AND action = 'owner.signup_requested' AND detail_json = ?2) < ?4`;

/**
 * I3 (DECIDED 2026-10-07): an owner's request (active or disabled) writes the same network row, never refused by it, so
 * the network's count cannot tell an address with an account from one without. ?1 now, ?2 the detail ({ ipHash }).
 */
export const NETWORK_ROW_SQL = `INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (?1, 'signup', 'owner.signup_requested', NULL, ?2)`;
