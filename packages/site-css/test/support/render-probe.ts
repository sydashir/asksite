// A throwaway Worker for tests: renders the POSTed SiteDocument with DESIGN_CSS, so a test can prove
// zod + render() bundle and run inside workerd exactly as they do in Node, and that the page's own
// design picks its sheet (A12). GET /process answers whether Node.js's `process` exists inside it (A13:
// it must not).
import { render } from "@asksite/renderer";
import type { SiteDocumentInput } from "@asksite/site-schema";
import { DESIGN_CSS } from "../../src/index.ts";
import { PROBE_FORM_ACTION } from "./probe-form-action.ts";

export default {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/process") return new Response(typeof process);
    const doc = (await request.json()) as SiteDocumentInput;
    try {
      const page = render(doc, { stylesheets: DESIGN_CSS, formAction: PROBE_FORM_ACTION });
      const headers = { "content-type": "text/html; charset=utf-8", "x-design": page.design, "x-stylesheet-sha256": page.stylesheetSha256 };
      return new Response(page.html, { headers });
    } catch (error) {
      return new Response(error instanceof Error ? error.name : "Error", { status: 422 });
    }
  },
};
