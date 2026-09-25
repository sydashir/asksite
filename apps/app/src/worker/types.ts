
export interface SignedInOwner {
  id: string;
  email: string;
}

/** Hono generics for every route: the Worker's bindings and what middleware stores on the context. */
export interface AppEnv {
  Bindings: Env;
  Variables: { owner: SignedInOwner; sessionHash: string };
}
