// The publishing harness Worker. Tests use it for its real local D1 and R2 bindings, and it reports
// whether Node.js compatibility is off inside it (A13). Both answers are needed: with only
// nodejs_compat_v2 off, `typeof process` is already "undefined", but node:* modules (and process.env
// with the text bindings) are still there; node:buffer goes only when nodejs_compat is off too.
export default {
  async fetch(): Promise<Response> {
    // Built at run time, so the bundler leaves the import to the Workers runtime.
    const nodeBuffer = ["node", "buffer"].join(":");
    const buffer = await import(nodeBuffer).then(() => "importable", () => "absent");
    return Response.json({ process: typeof process, nodeBuffer: buffer });
  },
};
