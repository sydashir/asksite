// Runs both real adapters inside workerd with a stand-in fetch (no network), so a test can prove
// the Anthropic SDK and our fetch code work in the Workers runtime without nodejs_compat.
import { AnthropicProvider } from "../../../../packages/generation/src/providers/anthropic.ts";
import { OpenAICompatibleProvider } from "../../../../packages/generation/src/providers/openai-compatible.ts";
import { AI_DRAFT_JSON_SCHEMA } from "../../../../packages/generation/src/wire-schema.ts";

const reply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

export default {
  async fetch(): Promise<Response> {
    const seen: string[] = [];
    const stub = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push(`${request.method} ${request.url}`);
      return request.url.includes("anthropic")
        ? reply({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: '{"ok":true,"x":null}' }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 2 } })
        : reply({ model: "m", choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 4 } });
    }) as typeof fetch;
    const req = { system: "s", user: "u", jsonSchema: AI_DRAFT_JSON_SCHEMA, maxOutputTokens: 100, signal: AbortSignal.timeout(90_000) };
    const anthropic = await new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: stub }).generate(req);
    const compatible = await new OpenAICompatibleProvider({ baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m", fetch: stub }).generate(req);
    return Response.json({ anthropic, compatible, seen });
  },
};
