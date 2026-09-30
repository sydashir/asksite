/** A fetch stand-in: records each request and answers from a list of responses or errors. */
export function fakeFetch(steps: Array<{ status: number; body: unknown } | Error>) {
  const calls: Array<{ url: string; headers: Headers; redirect: string; body: Record<string, unknown> }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    calls.push({ url: request.url, headers: request.headers, redirect: request.redirect, body: JSON.parse(await request.text()) as Record<string, unknown> });
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const step = steps[calls.length - 1];
    if (step === undefined) throw new Error("fakeFetch: no more steps");
    if (step instanceof Error) throw step;
    return new Response(JSON.stringify(step.body), { status: step.status, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

export const abortedSignal = (): AbortSignal => AbortSignal.abort(new DOMException("timed out", "TimeoutError"));
