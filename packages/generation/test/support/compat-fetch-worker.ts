// A throwaway Worker for tests (compat-fetch.workerd.test.ts). It builds the OpenAI-compatible adapter inside workerd
// with the runtime's own fetch injected, as a caller may, and answers what one generate() call gave. GET /method-call
// calls the runtime's fetch as a method of another object, the call shape the adapter must not use. GET /process
// answers whether Node.js's `process` exists here (A13: it must not).
import { ProviderError } from "../../src/provider.ts";
import { OpenAICompatibleProvider } from "../../src/providers/openai-compatible.ts";
import { AI_DRAFT_JSON_SCHEMA } from "../../src/wire-schema.ts";
import { PROBE_BASE_URL, PROBE_KEY, PROBE_MODEL } from "./compat-probe.ts";

export default {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/process") return new Response(typeof process);
    if (path === "/method-call") {
      const holder = { fetch };
      try {
        await holder.fetch(`${PROBE_BASE_URL}/method-call`);
        return new Response("no error");
      } catch (error) {
        return new Response(String(error));
      }
    }
    const provider = new OpenAICompatibleProvider({ baseUrl: PROBE_BASE_URL, apiKey: PROBE_KEY, model: PROBE_MODEL, fetch });
    const req = { system: "SYS", user: "USER", jsonSchema: AI_DRAFT_JSON_SCHEMA, maxOutputTokens: 16, signal: new AbortController().signal };
    try {
      return Response.json({ answer: await provider.generate(req) });
    } catch (error) {
      return Response.json({ error: String(error), kind: error instanceof ProviderError ? error.kind : null });
    }
  },
};
