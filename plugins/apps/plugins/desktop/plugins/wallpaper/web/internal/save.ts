import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  importWallpaperUrl,
  uploadWallpaper,
  type WallpaperCandidate,
  type SavedWallpaper,
} from "../../core";

/**
 * Funnel a provider candidate through the correct server save path and return
 * the saved `{ version, mime }`. A `file` candidate uploads as multipart; a
 * `remote` candidate imports server-side (SSRF-guarded). The picker writes
 * config from the result — this helper persists bytes only.
 */
export async function saveCandidate(
  candidate: Exclude<WallpaperCandidate, { kind: "builtin" }>,
): Promise<SavedWallpaper> {
  if (candidate.kind === "file") {
    const form = new FormData();
    form.set("file", candidate.file);
    return fetchEndpoint(uploadWallpaper, {}, { body: form });
  }
  return fetchEndpoint(
    importWallpaperUrl,
    {},
    { body: { url: candidate.url, attribution: candidate.attribution } },
  );
}
