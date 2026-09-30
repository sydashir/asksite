// A throwaway Worker for worker.workerd.test.ts (A13): the generator's own handlers plus GET /process, which answers
// whether Node.js's `process` exists where the generator's code runs. It imports the real src/index.ts, so the whole
// module graph (the Anthropic SDK included) loads here, under the generator's compatibility date and flags.
import generator from "../../src/index.ts";

export default {
  ...generator,
  async fetch(): Promise<Response> {
    return new Response(typeof process);
  },
};
