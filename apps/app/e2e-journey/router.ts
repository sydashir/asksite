// The journey server's front Worker: sends each request to the Worker that owns its host, as the
// production routes do (app.<root> to the app, admin.<root> to the admin, every other host to the
// sites Worker). Through a service binding the target Worker's static assets are served as in
// production; the harness's own route matching would skip them.
interface Service {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  APP: Service;
  ADMIN: Service;
  SITES: Service;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const host = new URL(request.url).hostname;
    if (host === "app.localhost") return env.APP.fetch(request);
    if (host === "admin.localhost") return env.ADMIN.fetch(request);
    return env.SITES.fetch(request);
  },
};
