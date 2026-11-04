import crypto from "node:crypto";
import { z } from "zod";
import { safeFetch, SsrfError } from "@plugins/infra/plugins/safe-fetch/server";
import { extractUgTabId, UgFetchError } from "../../core";
import type { UgSearchResult } from "../../core";
import type { UgTab } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/tab/core";

/**
 * Ultimate Guitar mobile-API client.
 *
 * ⚠️ FRAGILE BY DESIGN. UG has no public API; this targets the undocumented
 * Android mobile API with app-version + per-request signing headers that UG can
 * rotate at any time. There is no fallback (mobile-API-only). Every breakage
 * surfaces as a loud `UgFetchError` — never a silent failure.
 *
 * Confirmed signing scheme (verified empirically against tab 3250376):
 *   deviceId = first 16 chars of a random 16-byte hex string
 *   apiKey   = md5( deviceId + "<UTC yyyy-mm-dd>:<UTC hour int, no leading 0>createLog()" )
 * If UG returns 498 ("Token expired/invalid"), the signing scheme rotated and
 * the headers below need updating.
 */

const UG_API_BASE = "https://api.ultimate-guitar.com/api/v1/tab/info";
const UG_SEARCH_API_BASE = "https://api.ultimate-guitar.com/api/v1/tab/search";
const UG_USER_AGENT = "UGT_ANDROID/4.11.1 (Pixel; 8.1.0)";
const FETCH_TIMEOUT_MS = 15_000;

/** Tolerant view of the flat UG mobile-API response — only the fields we map. */
const UgApiResponseSchema = z.object({
  id: z.number(),
  song_name: z.string(),
  artist_name: z.string(),
  content: z.string(),
  type: z.string().optional(),
  tonality_name: z.string().optional(),
  capo: z.number().optional(),
  tuning: z.string().optional(),
  urlWeb: z.string().optional(),
});

/**
 * Tolerant view of the UG mobile-API `/tab/search` response. The result entries
 * live under `tabs` (verified against a live `title=wonderwall` response);
 * `artists` (a parallel artist-match list) is ignored. Each entry carries many
 * more fields than we map — only the slim subset below is required, and `id`
 * is `.optional()` so a shape-less entry is dropped (not a hard parse failure).
 */
const UgApiSearchResponseSchema = z.object({
  tabs: z.array(
    z.object({
      id: z.number().optional(),
      song_name: z.string().optional(),
      artist_name: z.string().optional(),
      type: z.string().optional(),
      rating: z.number().optional(),
      votes: z.number().optional(),
      version: z.number().optional(),
    }),
  ),
});

/** Generate a fresh, stateless device id + signing key pair for this request. */
function buildAuthHeaders(): { deviceId: string; apiKey: string } {
  const deviceId = crypto.randomBytes(16).toString("hex").slice(0, 16);
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  // Hour is an integer with NO leading zero. Salt literal is exactly `createLog()`.
  const payload = `${deviceId}${yyyy}-${mm}-${dd}:${now.getUTCHours()}createLog()`;
  const apiKey = crypto.createHash("md5").update(payload).digest("hex");
  return { deviceId, apiKey };
}

/**
 * Issue a signed GET to UG's mobile API with the shared Android headers and
 * loud network-error wrapping. `context` describes the operation (e.g.
 * `tab 3250376`, `search "wonderwall"`) and is woven into the `network` error
 * message. Shared by tab-info fetch and search so the transport + auth + the
 * wrappable-error set live in exactly one place.
 */
async function signedUgGet(apiUrl: string, context: string): Promise<Response> {
  const { deviceId, apiKey } = buildAuthHeaders();
  try {
    return await safeFetch(apiUrl, {
      headers: {
        "User-Agent": UG_USER_AGENT,
        Accept: "application/json",
        "Accept-Charset": "utf-8",
        "X-UG-CLIENT-ID": deviceId,
        "X-UG-API-KEY": apiKey,
      },
      timeoutMs: FETCH_TIMEOUT_MS,
    });
  } catch (err) {
    // Expected wrappable set: SSRF block, transport/DNS failure (TypeError),
    // and timeout/abort. Anything else is truly unexpected → rethrow loudly.
    if (
      err instanceof SsrfError ||
      err instanceof TypeError ||
      (err instanceof Error && err.name === "AbortError")
    ) {
      throw new UgFetchError(
        "network",
        `Network error reaching Ultimate Guitar (${context}): ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }
    throw err;
  }
}

/**
 * Classify a non-2xx UG mobile-API status into a `UgFetchError`. Handles the
 * statuses common to every route (400 → bad-request, 498 → signature-rejected,
 * other → upstream). Callers with route-specific statuses (e.g. fetch's 404)
 * must handle those *before* delegating here. Never returns.
 */
function throwForUgStatus(status: number, context: string): never {
  switch (status) {
    case 400:
      throw new UgFetchError(
        "bad-request",
        `Ultimate Guitar rejected the request (400 Bad Request) for ${context} — the required mobile-API headers/params may have changed.`,
      );
    case 498:
      throw new UgFetchError(
        "signature-rejected",
        `Ultimate Guitar rejected the request signature (498) for ${context} — the mobile-API signing scheme has likely rotated; update the signing headers in ug-client.ts.`,
      );
    default:
      throw new UgFetchError(
        "upstream",
        `Ultimate Guitar returned an unexpected status ${status} for ${context}.`,
      );
  }
}

/**
 * Resolve a pasted UG tab URL to a `UgTab`. Fails loudly: every distinct
 * breakage becomes a classified `UgFetchError`. NO persistence, NO markup
 * parsing — `content` is carried verbatim.
 */
export async function fetchUgTabContent(url: string): Promise<UgTab> {
  const tabId = extractUgTabId(url); // throws UgFetchError{kind:"invalid-url"}

  const apiUrl = `${UG_API_BASE}?tab_id=${tabId}&tab_access_type=private`;
  const res = await signedUgGet(apiUrl, `tab ${tabId}`);

  if (!res.ok) {
    if (res.status === 404) {
      throw new UgFetchError(
        "not-found",
        `Ultimate Guitar tab ${tabId} not found (404).`,
      );
    }
    throwForUgStatus(res.status, `tab ${tabId}`);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    throw new UgFetchError(
      "malformed-response",
      `Ultimate Guitar returned a non-JSON body for tab ${tabId} — the mobile-API response shape may have changed.`,
      { cause: err },
    );
  }

  const parsed = UgApiResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new UgFetchError(
      "malformed-response",
      `Ultimate Guitar response for tab ${tabId} failed validation — the mobile-API response shape may have changed: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }

  const data = parsed.data;
  const key =
    data.tonality_name && data.tonality_name.trim() ? data.tonality_name : null;

  return {
    tabId: String(data.id),
    songName: data.song_name,
    artistName: data.artist_name,
    type: data.type ?? "",
    key,
    capo: data.capo ?? 0,
    tuning: data.tuning ?? "",
    content: data.content,
    urlWeb: data.urlWeb ?? "",
  };
}

/**
 * Search the UG catalog by free text via the signed mobile API. Returns the
 * slim candidate list (id + display metadata); the caller builds a
 * `/tab/<tabId>` URL to import a pick. Same transport, auth, and loud-failure
 * taxonomy as `fetchUgTabContent`. NO type filtering — UG ignores `type=` here
 * and returns all kinds; the client filters on the returned `type` string.
 * Entries without a numeric `id` are dropped (they can't be imported).
 */
export async function searchUgTabContent(
  query: string,
): Promise<UgSearchResult[]> {
  const context = `search "${query}"`;
  const apiUrl = `${UG_SEARCH_API_BASE}?title=${encodeURIComponent(query)}&page=1`;
  const res = await signedUgGet(apiUrl, context);

  if (!res.ok) {
    // For SEARCH, a 404 means "no tabs matched" — a normal empty result, not an
    // upstream failure (unlike the fetch path, where 404 = a specific tab id is
    // gone). Return an empty list so the UI shows "No results", not an error.
    if (res.status === 404) return [];
    throwForUgStatus(res.status, context);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    throw new UgFetchError(
      "malformed-response",
      `Ultimate Guitar returned a non-JSON body for ${context} — the mobile-API search response shape may have changed.`,
      { cause: err },
    );
  }

  const parsed = UgApiSearchResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new UgFetchError(
      "malformed-response",
      `Ultimate Guitar ${context} response failed validation — the mobile-API search response shape may have changed: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }

  const results: UgSearchResult[] = [];
  for (const entry of parsed.data.tabs) {
    if (typeof entry.id !== "number") continue; // un-importable; drop it.
    results.push({
      tabId: String(entry.id),
      songName: entry.song_name ?? "",
      artistName: entry.artist_name ?? "",
      type: entry.type ?? "",
      rating: entry.rating ?? 0,
      votes: entry.votes ?? 0,
      version: entry.version ?? null,
    });
  }
  return results;
}
