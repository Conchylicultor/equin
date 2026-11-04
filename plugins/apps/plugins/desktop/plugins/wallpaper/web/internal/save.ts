import type { FetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  importWallpaperUrl,
  uploadWallpaper,
  type WallpaperCandidate,
  type SavedWallpaper,
} from "../../core";

/** A save's outcome: the saved image, or why this host cannot save it. */
export type SaveOutcome =
  | { kind: "saved"; saved: SavedWallpaper }
  // A link import needs the computer (an SSRF-guarded server-side download):
  // a browser host answers this, with the user-facing message.
  | { kind: "unavailable"; message: string };

/**
 * Funnel a provider candidate through the correct server save path and return
 * the saved `{ version, mime }`. A `file` candidate uploads as multipart; a
 * `remote` candidate imports server-side (SSRF-guarded), which only the
 * computer's server can. The picker writes config from the result — this
 * helper persists bytes only.
 */
export async function saveCandidate(
  fetchEndpoint: FetchEndpoint,
  candidate: Exclude<WallpaperCandidate, { kind: "builtin" }>,
): Promise<SaveOutcome> {
  if (candidate.kind === "file") {
    const form = new FormData();
    form.set("file", candidate.file);
    const saved = await fetchEndpoint(uploadWallpaper, {}, { body: form });
    return { kind: "saved", saved };
  }
  const answer = await fetchEndpoint(
    importWallpaperUrl,
    {},
    { body: { url: candidate.url, attribution: candidate.attribution } },
  );
  return answer.kind === "ok"
    ? { kind: "saved", saved: answer.value }
    : { kind: "unavailable", message: answer.message };
}
