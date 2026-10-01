import { PublishError } from "../../src/index.ts";

/** Awaits a call that must fail with a PublishError and returns it. */
export async function publishFailure(promise: Promise<unknown>): Promise<PublishError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  if (!(error instanceof PublishError)) throw new Error(`expected a PublishError, got ${String(error)}`);
  return error;
}
