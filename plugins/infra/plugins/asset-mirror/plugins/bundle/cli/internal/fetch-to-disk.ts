import { dirname } from "node:path";
import { mkdir, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  remoteFileUrl,
  verifyPinnedBytes,
  type AssetMirrorSource,
} from "@plugins/infra/plugins/asset-mirror/core";

/**
 * Download one pinned file and check it against its pin (`verifyPinnedBytes`
 * — the same check the lazy cache miss runs) and atomically write it to `diskPath`: the
 * parent dir is created, and the bytes land via a temp file + rename so a
 * concurrent reader never observes a half-written buffer.
 *
 * FAIL LOUD: an upstream failure or a pin mismatch throws and nothing is
 * written; the prewarm runner aborts the release.
 */
export async function mirrorFetchToDisk(opts: {
  source: AssetMirrorSource;
  file: string;
  diskPath: string;
}): Promise<void> {
  const upstream = remoteFileUrl(opts.source, opts.file);
  const res = await fetch(upstream);
  if (!res.ok) {
    throw new Error(
      `[asset-mirror] upstream ${res.status} for "${opts.file}" (${upstream})`,
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  await verifyPinnedBytes(opts.source, opts.file, bytes);
  await mkdir(dirname(opts.diskPath), { recursive: true });
  const tmp = `${opts.diskPath}.tmp.${randomUUID()}`;
  await Bun.write(tmp, bytes);
  await rename(tmp, opts.diskPath);
}
