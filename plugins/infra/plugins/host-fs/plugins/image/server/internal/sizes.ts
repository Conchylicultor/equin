import sharp from "sharp";
import { openHostFile } from "@plugins/infra/plugins/host-fs/server";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { resizedVersion, type ImageSize } from "../../core";

/** Header reads are a few ms each; bounded so a big folder cannot open hundreds of files at once. */
const reads = createSemaphore(8);

/** Sizes already read, by `path|version`. Bounded: oldest dropped first. */
const MEMO_MAX = 20_000;
const memo = new Map<string, ImageSize>();

function remember(key: string, size: ImageSize): ImageSize {
  memo.delete(key);
  memo.set(key, size);
  if (memo.size > MEMO_MAX) {
    const oldest = memo.keys().next();
    if (!oldest.done) memo.delete(oldest.value);
  }
  return size;
}

/** EXIF orientations 5–8 turn the image a quarter: width and height swap. */
export function uprightSize(meta: {
  width?: number;
  height?: number;
  orientation?: number;
}): ImageSize {
  if (meta.width === undefined || meta.height === undefined)
    return { kind: "unreadable" };
  const turned = (meta.orientation ?? 1) >= 5;
  return {
    kind: "known",
    width: turned ? meta.height : meta.width,
    height: turned ? meta.width : meta.height,
  };
}

/** The upright size of one image, or `null` when it vanished meanwhile. */
export async function sizeOf(path: string): Promise<ImageSize | null> {
  const file = await openHostFile(path);
  if (file.kind !== "ok") return null;
  const key = `${file.path}\0${resizedVersion(file)}`;
  const known = memo.get(key);
  if (known) return known;
  return reads.run(async () => {
    try {
      const meta = await sharp(file.onDisk ? file.path : await file.read(), {
        failOn: "none",
      }).metadata();
      return remember(key, uprightSize(meta));
    } catch (err) {
      // sharp reports an undecodable header as a plain Error.
      if (err instanceof Error) return remember(key, { kind: "unreadable" });
      throw err;
    }
  });
}
