import type { ErrorBody } from "@asksite/core";

export type ApiError = ErrorBody["error"];
export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: ApiError };

/** The words for any failure the server did not explain. */
export const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

const OFFLINE: ApiError = { code: "internal", message: "We could not reach the server. Check your connection and try again." };

/** Same-origin JSON (or multipart) request to the owner API; `headers` adds request headers. Never throws. */
export async function api<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResult<T>> {
  const init: RequestInit = { method, credentials: "same-origin", headers };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.headers = { ...headers, "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    return { ok: false, status: 0, error: OFFLINE };
  }
  if (res.status === 204) return { ok: true, status: 204, data: undefined as T };
  const json: unknown = await res.json().catch(() => null);
  if (res.ok) return { ok: true, status: res.status, data: json as T };
  const error = (json as Partial<ErrorBody> | null)?.error;
  return { ok: false, status: res.status, error: error ?? { code: "internal", message: GENERIC_ERROR_MESSAGE } };
}
