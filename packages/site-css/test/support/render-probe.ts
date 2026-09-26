// A throwaway Worker for tests: renders the POSTed SiteDocument with the shared stylesheet, so a
// test can prove zod + render() bundle and run inside workerd exactly as they do in Node. GET /process
// answers whether Node.js's `process` exists inside it (A13: it must not).
import { render } from "@asksite/renderer";
import type { SiteDocumentInput } from "@asksite/site-schema";
import { SITE_CSS } from "../../src/index.ts";
import { PROBE_FORM_ACTION } from "./probe-form-action.ts";

export default {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/process") return new Response(typeof process);
    const doc = (await request.json()) as SiteDocumentInput;
    try {
      const page = render(doc, { stylesheet: SITE_CSS, formAction: PROBE_FORM_ACTION });
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    } catch (error) {
      return new Response(error instanceof Error ? error.name : "Error", { status: 422 });
    }
  },
};
