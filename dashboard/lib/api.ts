// The browser's calls to back, through the dashboard's proxy (app/api/back). Never throws: every
// outcome is a value, so each caller handles failure explicitly.
import type { ApiError } from "@sandboxrouting/back/api";

export type Failure =
  /** The session's key is gone or revoked: sign in again. */
  | { kind: "unauthorized"; message: string }
  /** The request never got an answer (offline, back down). */
  | { kind: "network"; message: string }
  /** back answered with an error. */
  | { kind: "http"; status: number; code: string; message: string; body?: ApiError["error"] };

export type Outcome<T> = { ok: true; data: T } | { ok: false; failure: Failure };

export async function api<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal } = {}): Promise<Outcome<T>> {
  let res: Response;
  try {
    res = await fetch(`/api/back/${path}`, {
      method: init.method ?? "GET",
      headers: { "x-requested-with": "sbr-dashboard", ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      cache: "no-store",
      ...(init.signal ? { signal: init.signal } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return { ok: false, failure: { kind: "network", message: "Can't reach the dashboard server." } };
  }
  const text = await res.text().catch(() => "");
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (res.ok) return { ok: true, data: body as T };
  const error = (body as ApiError | undefined)?.error;
  if (res.status === 401) return { ok: false, failure: { kind: "unauthorized", message: error?.message ?? "Sign in again." } };
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    return { ok: false, failure: { kind: "network", message: error?.message ?? "back can't be reached." } };
  }
  return { ok: false, failure: { kind: "http", status: res.status, code: error?.code ?? "error", message: error?.message ?? `back answered ${res.status}.`, ...(error ? { body: error } : {}) } };
}
