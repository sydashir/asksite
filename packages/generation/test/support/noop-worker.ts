// The smallest Worker that can own a local D1 binding for tests.
export default {
  async fetch(): Promise<Response> {
    return new Response("ok");
  },
};
