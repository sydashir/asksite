/**
 * The per-network limit on self-serve sign-ups: one audit_log row per attempt, written only while the network has fewer
 * than ?4 rows today, counted in the same statement. ?1 now, ?2 the detail ({ ipHash }), ?3 the UTC day's start. The
 * count reads the audit_site (site_id, at) index (signup.workerd.test.ts checks the query plan). Its own module, with no
 * Worker types, so that test can import it.
 */
export const NETWORK_SIGNUP_SQL = `INSERT INTO audit_log (at, actor, action, site_id, detail_json)
  SELECT ?1, 'signup', 'owner.signup_requested', NULL, ?2
  WHERE (SELECT COUNT(*) FROM audit_log WHERE site_id IS NULL AND at >= ?3 AND action = 'owner.signup_requested' AND detail_json = ?2) < ?4`;
