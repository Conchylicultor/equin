import { PlacesApiError, type PlacesClient, type PlacesSku } from "../../core";

/** Places API (New) host. Every path below is ours, never user-supplied. */
export const PLACES_BASE = "https://places.googleapis.com/v1";

/** Shape of Google's JSON error envelope. */
interface PlacesErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

/**
 * Perform one Places call and return its parsed JSON body. The call is counted
 * on the client's meter as `sku` first — recorded before the request, since a
 * refused call may still be billed.
 *
 * Plain `fetch` on purpose: `@plugins/infra/plugins/safe-fetch` exists to guard
 * URLs a USER supplied (SSRF), and `places.googleapis.com` is a fixed host we
 * wrote into the code. Routing this through safeFetch would buy nothing — do
 * not "fix" it later.
 *
 * There is no retry ladder here (unlike gmail-api's `gmailRequest`): both calls
 * sit on a human's keystroke inside an autocomplete session, where a silent
 * 30-second backoff is worse than a visible failure.
 */
export async function placesFetch<T>(
  url: URL,
  client: PlacesClient,
  init: {
    method: "GET" | "POST";
    sku: PlacesSku;
    fieldMask?: string;
    body?: unknown;
  },
): Promise<T> {
  await client.meter.record(init.sku);
  const headers: Record<string, string> = { "X-Goog-Api-Key": client.apiKey };
  if (init.fieldMask) headers["X-Goog-FieldMask"] = init.fieldMask;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  if (!res.ok) {
    const text = await res.text();
    const { message, reason } = parseError(text);
    throw new PlacesApiError(
      res.status,
      message ?? `Places request failed (${res.status})`,
      reason,
    );
  }

  return (await res.json()) as T;
}

/** Parse `{ error: { message, status } }`, tolerating a non-JSON body. */
function parseError(bodyText: string): { message?: string; reason?: string } {
  try {
    const body = JSON.parse(bodyText) as PlacesErrorBody;
    return {
      message: body.error?.message ?? bodyText,
      reason: body.error?.status,
    };
  } catch (err) {
    // The only thrower here is JSON.parse on a non-JSON body — a normal case for
    // some Google error responses. Anything else is unexpected: re-throw.
    if (!(err instanceof SyntaxError)) throw err;
    return { message: bodyText };
  }
}
