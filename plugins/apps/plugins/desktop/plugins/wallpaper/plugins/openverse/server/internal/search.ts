import { HttpError } from "@plugins/infra/plugins/endpoints/server";
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
/** Cap the result grid — one page is plenty for picking a wallpaper. */
const PAGE_SIZE = 30;

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
 * Search Openverse for open-license images matching `q`. Mirrors the
 * `page/bookmark/scrape.ts` error convention: SSRF / network conditions surface
 * as a 502 `HttpError` (the picker shows "Search failed"); unexpected errors
 * rethrow so they crash loudly rather than masquerade as "no results".
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
      throw new HttpError(502, "Openverse endpoint is unreachable.");
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
      throw new HttpError(502, "Openverse search failed (network).");
    }
    throw err;
  }

  // Openverse's anonymous tier is heavily rate-limited (Cloudflare-fronted): once
  // the small anonymous burst is spent it answers 401/429. Surface that as a clear,
  // user-actionable message rather than a generic failure.
  if (res.status === 401 || res.status === 429) {
    throw new HttpError(
      429,
      "Openverse is rate-limiting anonymous requests right now. Try again in a minute, or use Upload / From URL.",
    );
  }
  if (!res.ok) {
    throw new HttpError(502, `Openverse search failed (status ${res.status}).`);
  }

  const body = (await res.json()) as OpenverseResponse;
  return (body.results ?? []).slice(0, PAGE_SIZE).map(toResult);
}
