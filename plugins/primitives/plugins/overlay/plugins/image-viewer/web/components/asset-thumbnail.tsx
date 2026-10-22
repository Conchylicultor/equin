import type { AssetPath } from "@plugins/infra/plugins/endpoints/core";
import {
  useAssetSrc,
  type AssetSrc,
} from "@plugins/infra/plugins/endpoints/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import type { ViewerImage } from "../internal/types";
import { MissingImage, type MissingImageProps } from "./missing-image";
import { ViewerThumbnail, type ViewerThumbnailProps } from "./viewer-thumbnail";

/**
 * What an image whose asset is not loadable yet (`useAssetSrc` answered
 * anything but `ready`) shows in its place: the loading state while its bytes
 * are fetched, the missing-image box — the reason in its tooltip — when the
 * host cannot serve it (`unavailable`) or the fetch failed (`error`).
 */
export function UnloadedAssetImage({
  src,
  name,
  size,
}: {
  src: Exclude<AssetSrc, { kind: "ready" }>;
  name: string;
  size?: MissingImageProps["size"];
}) {
  switch (src.kind) {
    case "loading":
      return <Loading variant="spinner" />;
    case "unavailable":
      return (
        <MissingImage
          name={name}
          title={src.message}
          reason="gone"
          size={size}
        />
      );
    case "error":
      return (
        <MissingImage
          name={name}
          title={src.message}
          reason="unreadable"
          size={size}
        />
      );
  }
}

/**
 * A {@link ViewerThumbnail} of a server asset (an attachment, a checkout
 * image, a host file): its bytes loaded over the subtree's transport
 * (`useAssetSrc`), {@link UnloadedAssetImage} until they are loadable.
 */
export function AssetThumbnail({
  asset,
  image,
  size,
  children,
}: Omit<ViewerThumbnailProps, "image"> & {
  asset: AssetPath;
  /** The viewer image, less the `src` the asset resolves to. */
  image: Omit<ViewerImage, "src">;
}) {
  const src = useAssetSrc(asset);
  if (src.kind !== "ready") {
    return <UnloadedAssetImage src={src} name={image.name} size={size} />;
  }
  return (
    <ViewerThumbnail image={{ ...image, src: src.src }} size={size}>
      {children}
    </ViewerThumbnail>
  );
}
