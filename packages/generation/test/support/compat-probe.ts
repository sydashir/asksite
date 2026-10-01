// Shared by the compat fetch probe Worker (compat-fetch-worker.ts) and its test. A Worker's main module may export only
// handlers (workerd refuses other named exports), so the constants live here.

/** The adapter's base URL: a .invalid host (RFC 6761), so no request can leave the machine. The test answers it. */
export const PROBE_BASE_URL = "https://compat-probe.example.invalid/v1";
export const PROBE_KEY = "compat-probe-key";
export const PROBE_MODEL = "compat-probe-model";
