// The smallest Worker: tests use it to get real local D1 bindings from createTestHarness. It answers whether
// Node.js's `process` exists inside it (A13: it must not).
export default {
  fetch(): Response {
    return new Response(typeof process);
  },
};
