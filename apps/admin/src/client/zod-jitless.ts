import { z } from "zod";

// Imported first by main.tsx, before any schema is built. Zod 4 probes `new Function("")` to decide whether it may
// compile faster parsers, and a strict Content-Security-Policy (script-src without 'unsafe-eval', which is the
// admin's) reports that probe as a violation even though the throw is swallowed. `jitless` skips the probe
// (zod 4.6.5, v4/core/util.js allowsEval). Parsing is then the plain interpreter, which is fast enough for these forms.
z.config({ jitless: true });
