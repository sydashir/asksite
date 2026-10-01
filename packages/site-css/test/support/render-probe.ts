// A throwaway Worker for tests: renders the POSTed SiteDocument with DESIGN_CSS, so a test can prove
// zod + render() bundle and run inside workerd exactly as they do in Node, and that the page's own
// design picks its sheet (A12). The body is the site's pages as JSON (A16). GET /process answers whether Node.js's `process` exists inside it (A13:
// it must not).
import { render } from "@asksite/renderer";
import type { SiteDocumentInput } from "@asksite/site-schema";
import { DESIGN_CSS } from "../../src/index.ts";
import { PROBE_FORM_ACTION, PROBE_SITE_URL } from "./probe-form-action.ts";

export default {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/process") return new Response(typeof process);
    const doc = (await request.json()) as SiteDocumentInput;
    try {
      const site = render(doc, { stylesheets: DESIGN_CSS, formAction: PROBE_FORM_ACTION, siteUrl: PROBE_SITE_URL });
      const headers = { "x-design": site.design, "x-stylesheet-sha256": site.stylesheetSha256 };
      return Response.json(site.pages, { headers });
    } catch (error) {
      return new Response(error instanceof Error ? error.name : "Error", { status: 422 });
    }
  },
};
