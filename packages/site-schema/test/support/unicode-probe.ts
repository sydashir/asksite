// A throwaway Worker for tests: answers unicode-version.ts's questions from inside workerd (unicode.workerd.test.ts),
// and says whether Node.js's `process` exists there (A13: it must not).
import { unicodeVersion } from "./unicode-version.ts";

export default {
  fetch(): Response {
    return Response.json({ unicode: unicodeVersion(), process: typeof process });
  },
};
