import {
  useAssetSrc,
  useAssetSrcs,
} from "@plugins/infra/plugins/endpoints/web";
import type { AssetPath } from "@plugins/infra/plugins/endpoints/core";

/**
 * What an `<img>` loads for a place photo or thumbnail, over the subtree's
 * transport — or null while it has none to load: loading, or not available
 * here (Google's photos need the computer's Places key, so a host without it
 * draws the box's own background — the tag wash, a muted tile).
 */
export function usePhotoSrc(asset: AssetPath): string | null {
  const src = useAssetSrc(asset);
  return src.kind === "ready" ? src.src : null;
}

/** {@link usePhotoSrc} for a set: every `src`, or null until all are loadable. */
export function usePhotoSrcs(assets: readonly AssetPath[]): string[] | null {
  const srcs = useAssetSrcs(assets);
  const ready: string[] = [];
  for (const s of srcs) {
    if (s.kind !== "ready") return null;
    ready.push(s.src);
  }
  return ready;
}
