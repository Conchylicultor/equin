import { z } from "zod";
import { getTokenFromCentral } from "@plugins/auth/server";
import {
  HOOKTHEORY_API_BASE,
  HOOKTHEORY_PROVIDER_ID,
} from "@plugins/auth/plugins/hooktheory/core";
import {
  HooktheoryApiError,
  HooktheoryNotSignedInError,
  HooktheoryProviderUnavailableError,
} from "../../core";
import { parseOrThrow } from "../../core/internal/parse";

/** Hooktheory's JSON error envelope: `{ name, message, code, status }`. */
const ErrorEnvelopeSchema = z.object({ message: z.string().min(1) });

/** Longest plain-text error body quoted into a message before it is cut. */
const MAX_TEXT_ERROR = 200;

/**
 * Perform one Hooktheory call and return its body, parsed with `schema`.
 *
 * `path` is relative to the API root and always ours (e.g. `/trends/nodes`);
 * `query` values are encoded here. With `auth`, the call carries the signed-in
 * account's token as a Bearer header.
 *
 * Plain `fetch` on purpose: `@plugins/infra/plugins/safe-fetch` exists to guard
 * URLs a USER supplied (SSRF), and `api.hooktheory.com` is a fixed host we
 * wrote into the code. Routing this through safeFetch would buy nothing — do
 * not "fix" it later.
 *
 * The success body is parsed with zod HERE, unlike places-api / gmail-api
 * (plain interfaces + an `as T` cast): the section payload is a free-form
 * editor document behind an undocumented endpoint, so a change in its shape has
 * to fail at this boundary with the field named, not deep inside the trainer.
 *
 * No retry, no cache, no rate limit: nothing calls this in a loop yet, and a
 * visible failure beats a silent backoff while we learn the API.
 *
 * Failures, all loud:
 * - no usable account (auth calls) → `HooktheoryNotSignedInError`
 * - Hooktheory answers non-2xx     → `HooktheoryApiError` with its message
 * - a 2xx body of the wrong shape  → `Error` naming the path and the fields
 */
export async function hooktheoryFetch<T>(
  path: string,
  init: {
    auth: boolean;
    query?: Record<string, string>;
    schema: z.ZodType<T>;
  },
): Promise<T> {
  const url = new URL(`${HOOKTHEORY_API_BASE}${path}`);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.auth) headers.Authorization = `Bearer ${await hooktheoryToken()}`;

  const res = await fetch(url, { headers });
  const text = await res.text();

  if (!res.ok) {
    const message = hooktheoryErrorText(res.status, text);
    // The token central handed us was refused: Hooktheory revoked or expired
    // it. Only signing in again mints a new one.
    throw new HooktheoryApiError(
      res.status,
      init.auth && res.status === 401
        ? `${message} — sign in to Hooktheory again in Settings → Accounts`
        : message,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new Error(
      `Hooktheory ${path} answered ${res.status} with a body that is not JSON: ${err.message}`,
    );
  }
  return parseOrThrow(init.schema, body, `Hooktheory ${path} response`);
}

/**
 * The signed-in account's token (Hooktheory calls it the `activkey`). The
 * integration owns this lookup so consumers never import `@plugins/auth`.
 */
async function hooktheoryToken(): Promise<string> {
  const res = await getTokenFromCentral({ providerId: HOOKTHEORY_PROVIDER_ID });
  if (res.ok) return res.accessToken;
  if (res.needsConsent) {
    throw new HooktheoryNotSignedInError(
      res.reason === "no-account" ? "not-signed-in" : "sign-in-expired",
    );
  }
  // Anything else is a deployment problem, not the user's.
  if (res.code === "unknown-provider") {
    throw new HooktheoryProviderUnavailableError(res.message);
  }
  throw new Error(`Hooktheory token unavailable: ${res.message}`);
}

/**
 * The human-readable reason in a non-2xx Hooktheory body. Hooktheory answers
 * most errors with its JSON envelope, but some (an unauthenticated
 * `/trends/nodes`) with a full HTML error page — that is never quoted into a
 * message; its `<title>` ("Unauthorized (#401)") stands in for it.
 */
export function hooktheoryErrorText(status: number, bodyText: string): string {
  const fallback = `Hooktheory request failed (HTTP ${status})`;
  const trimmed = bodyText.trim();
  if (trimmed === "") return fallback;

  if (trimmed.startsWith("<")) {
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(trimmed)?.[1]?.trim();
    return title ? `${fallback}: ${title}` : fallback;
  }

  try {
    const envelope = ErrorEnvelopeSchema.safeParse(JSON.parse(trimmed));
    if (envelope.success) return envelope.data.message;
  } catch (err) {
    // The only thrower here is JSON.parse on a plain-text body, which is then
    // quoted below. Anything else is unexpected: re-throw.
    if (!(err instanceof SyntaxError)) throw err;
  }
  return trimmed.length > MAX_TEXT_ERROR
    ? `${fallback}: ${trimmed.slice(0, MAX_TEXT_ERROR)}…`
    : `${fallback}: ${trimmed}`;
}
