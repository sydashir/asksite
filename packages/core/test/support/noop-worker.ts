// The smallest Worker: tests use it only to get real local D1 bindings from createTestHarness.
export default {
  fetch(): Response {
    return new Response("ok");
  },
};
