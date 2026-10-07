import { z } from "zod";

// Zod 4's JIT probe runs `new Function("")` when each object schema is built, and the app's strict CSP
// (no 'unsafe-eval') reports that caught call as a violation. Jitless skips the probe (zod 4.6.5
// v4/core/util.js:219-220). This module must be the first import of main.tsx, before any schema is built.
z.config({ jitless: true });
