/** One live provider response, saved as a test fixture (Task 15) and replayed offline by recorded.test.ts. */
export interface RecordedResponse {
  provider: "anthropic" | "openai-compatible";
  modelId: string;
  status: number;
  body: unknown;
}

/**
 * Wraps fetch and keeps each response's status and body. The request (and so the API key in its
 * headers) is never kept.
 */
export function recordingFetch(inner: typeof fetch, sink: Array<{ status: number; body: unknown }>): typeof fetch {
  return async (input, init) => {
    const response = await inner(input, init);
    const text = await response.clone().text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    sink.push({ status: response.status, body });
    return response;
  };
}

/** A safe file name for a candidate label, e.g. "workers-ai/gpt-oss-120b" -> "workers-ai__gpt-oss-120b.json". */
export const fixtureName = (label: string): string => `${label.replace(/[^a-zA-Z0-9.-]+/g, "__")}.json`;
