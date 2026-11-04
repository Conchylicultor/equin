import { dirname } from "node:path";
import { mkdir, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/**
 * Download a single mirrored file from `<remoteBaseUrl>/<encoded file>` and
 * atomically write it to `diskPath`. The one shared primitive behind both the
 * lazy cache-miss path (`handleMirror`) and the release prewarm runner
 * (`runAssetMirrorPrewarm`).
 *
 * The remote name is re-encoded segment by segment so a flat name with
 * spaces/`#` (e.g. `"PP C#1.ogg"`) reaches the CDN as `PP%20C%231.ogg`, and a
 * nested one (`en/data.json`) keeps its `/`. The parent dir is
 * created, and the bytes land via a temp file + rename so a concurrent reader
 * never observes a half-written buffer.
 *
 * FAIL LOUD: if the fetch throws or the upstream responds non-ok, this throws —
 * it never writes a partial/placeholder file. Callers own how to surface that
 * (the route logs + returns 502; the prewarm runner aborts the release).
 */
export async function mirrorFetchToDisk(opts: {
  remoteBaseUrl: string;
  file: string;
  diskPath: string;
}): Promise<void> {
  const { remoteBaseUrl, file, diskPath } = opts;
  const encoded = file.split("/").map(encodeURIComponent).join("/");
  const upstream = `${remoteBaseUrl}/${encoded}`;
  const res = await fetch(upstream);
  if (!res.ok) {
    throw new Error(
      `[asset-mirror] upstream ${res.status} for "${file}" (${upstream})`,
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  await mkdir(dirname(diskPath), { recursive: true });
  const tmp = `${diskPath}.tmp.${randomUUID()}`;
  await Bun.write(tmp, bytes);
  await rename(tmp, diskPath);
}
