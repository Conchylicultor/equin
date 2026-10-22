import {
  parsePublicUrl,
  safeFetch,
  SsrfError,
} from "@plugins/infra/plugins/safe-fetch/server";
import type { WallpaperResult } from "@plugins/apps/plugins/desktop/plugins/wallpaper/core";

/** Openverse image-search endpoint (no API key needed for basic use). */
const OPENVERSE_ENDPOINT = "https://api.openverse.org/v1/images/";
/**
 * Openverse rejects requests without a `User-Agent` (returns 401), so identify
 * the app explicitly — see https://api.openverse.org/v1/#tag/auth.
 */
const USER_AGENT = "Singularity/1.0 (+https://equin.ai; desktop wallpaper picker)";
/**
 * Cap the result grid — one page is plenty for picking a wallpaper. 20 is the
 * most Openverse serves an anonymous request: a larger `page_size` is answered
 * 401 ("page_size may not exceed 20 for anonymous requests").
 */
const PAGE_SIZE = 20;

/**
 * One result object from the Openverse `/v1/images/` response. Only the fields
 * we map are typed; the response carries many more (filesize, tags, …) we ignore.
 */
interface OpenverseImage {
  id: string;
  title?: string;
  creator?: string;
  url: string;
  thumbnail?: string;
  license?: string;
  license_version?: string;
  license_url?: string;
  foreign_landing_url?: string;
}

interface OpenverseResponse {
  results?: OpenverseImage[];
}

/** Compose the human license label, e.g. `"by-nc 2.0"`. */
function licenseLabel(image: OpenverseImage): string | undefined {
  if (!image.license) return undefined;
  return image.license_version
    ? `${image.license} ${image.license_version}`
    : image.license;
}

function toResult(image: OpenverseImage): WallpaperResult {
  return {
    id: image.id,
    thumbUrl: image.thumbnail ?? image.url,
    fullUrl: image.url,
    attribution: {
      creator: image.creator,
      license: licenseLabel(image),
      licenseUrl: image.license_url,
      sourceUrl: image.foreign_landing_url ?? image.url,
      title: image.title,
    },
  };
}

/**
 * Search Openverse for open-license images matching `q` — one page of at most
 * {@link PAGE_SIZE}. SSRF / network conditions and a failed response throw an
 * Error (the picker shows the failure, with Retry) — Openverse's rate limit
 * included: it is a passing failure a Retry can heal, never a refusal (a
 * refused question is never re-asked); unexpected errors rethrow so they crash loudly
 * rather than masquerade as "no results".
 */
export async function searchOpenverse(q: string): Promise<WallpaperResult[]> {
  const search = new URLSearchParams({
    q,
    page_size: String(PAGE_SIZE),
    license_type: "all",
    mature: "false",
  });
  const url = `${OPENVERSE_ENDPOINT}?${search.toString()}`;

  let target: URL;
  try {
    target = parsePublicUrl(url);
  } catch (err) {
    if (err instanceof SsrfError) {
      throw new Error("Openverse endpoint is unreachable.", { cause: err });
    }
    throw err;
  }

  let res: Response;
  try {
    res = await safeFetch(target, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    });
  } catch (err) {
    // Expected failure modes: SSRF block, a network-level fetch failure
    // (TypeError), or a timeout abort. Anything else is unexpected → rethrow so
    // it crashes loudly rather than masquerading as "search failed".
    if (
      err instanceof SsrfError ||
      err instanceof TypeError ||
      (err instanceof DOMException && err.name === "AbortError")
    ) {
      throw new Error("Openverse search failed (network).", { cause: err });
    }
    throw err;
  }

  // Openverse's anonymous tier is heavily rate-limited (Cloudflare-fronted): once
  // the small anonymous burst is spent it answers 401/429. That passes, so it is
  // a failure (the read's error, with Retry), not a refusal: a refusal is the
  // answer to the question, and the same question is never asked again.
  if (res.status === 401 || res.status === 429) {
    throw new Error(
      `Openverse is rate-limiting anonymous requests (status ${res.status}).`,
    );
  }
  if (!res.ok) {
    throw new Error(`Openverse search failed (status ${res.status}).`);
  }

  const body = (await res.json()) as OpenverseResponse;
  return (body.results ?? []).slice(0, PAGE_SIZE).map(toResult);
}
