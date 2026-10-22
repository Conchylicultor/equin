import { useState } from "react";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  fileRefName,
  fileUrl,
} from "@plugins/primitives/plugins/file-viewer/core";
import {
  UnloadedFile,
  type FileRendererProps,
} from "@plugins/primitives/plugins/file-viewer/web";
import { useAssetSrc } from "@plugins/infra/plugins/endpoints/web";
import {
  ImageViewer,
  MissingImage,
  useImageLoad,
  type ViewerImage,
} from "@plugins/primitives/plugins/overlay/plugins/image-viewer/web";
import { useFolderImages } from "../internal/use-folder-images";

/**
 * What the preview draws: a resized copy covering the whole window (the
 * preview never outgrows it) when the image offers one and is larger, else
 * the original — so a camera photo's preview never decodes 30 megapixels.
 */
function previewSrc(image: ViewerImage | undefined, src: string): string {
  if (!image?.resized || !image.width || !image.height) return src;
  const edge =
    Math.max(window.innerWidth, window.innerHeight) *
    (window.devicePixelRatio || 1);
  return Math.max(image.width, image.height) > edge ? image.resized(edge) : src;
}

/**
 * The fitted preview; a click opens the app's full-screen image viewer over
 * every image in the file's folder, ← / → stepping between them. A file that
 * does not load shows the missing-image box, with nothing to open.
 */
export function ImageView({ file }: FileRendererProps) {
  // The file's bytes over the subtree's transport (`useAssetSrc`).
  const asset = useAssetSrc(fileUrl(file));
  if (asset.kind !== "ready") return <UnloadedFile src={asset} />;
  return <LoadedImageView file={file} src={asset.src} />;
}

function LoadedImageView({
  file,
  src,
}: Pick<FileRendererProps, "file"> & { src: string }) {
  const name = fileRefName(file);
  const { images, pending } = useFolderImages(file);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  // The image on screen, by address: the folder listing can change under an
  // open viewer, so an index would drift.
  const [viewing, setViewing] = useState<string | null>(null);
  const index =
    viewing === null ? -1 : images.findIndex((i) => i.src === viewing);
  // A copy that fails to load falls back to the original, which then reports
  // its own failure.
  const [failedCopy, setFailedCopy] = useState<string | null>(null);
  const copy = previewSrc(
    images.find((i) => i.src === src),
    src,
  );
  const shown = failedCopy === copy ? src : copy;
  const { load, imgKey, imgProps, retry } = useImageLoad(shown);

  // Until the folder's sizes are known, which copy to draw is not: waiting
  // (a few ms) beats starting the original's full decode.
  if (pending) return <Loading variant="spinner" />;

  return (
    <Center axis="both" className="h-full p-lg">
      {load.kind === "failed" ? (
        <MissingImage name={name} reason={load.reason} onRetry={retry} />
      ) : (
        <img
          key={imgKey}
          ref={setImg}
          src={shown}
          alt={name}
          className="max-h-full max-w-full cursor-zoom-in object-contain"
          style={{ imageRendering: "pixelated" }}
          aria-haspopup="dialog"
          onClick={() => setViewing(src)}
          onError={() => {
            if (shown !== src) setFailedCopy(copy);
            else imgProps.onError();
          }}
          onLoad={(e) => {
            imgProps.onLoad(e);
            // restore crisp rendering only for small images
            const el = e.currentTarget;
            if (el.naturalWidth > 64 || el.naturalHeight > 64) {
              el.style.imageRendering = "auto";
            }
          }}
        />
      )}
      {index >= 0 && (
        <ImageViewer
          images={images}
          index={index}
          onIndexChange={(i) => setViewing(images[i]?.src ?? null)}
          onClose={() => setViewing(null)}
          // Only the previewed image has a place on the page to grow out of
          // and shrink back into; its siblings fade.
          originOf={(i) => (images[i]?.src === src ? img : null)}
        />
      )}
    </Center>
  );
}
