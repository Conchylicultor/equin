import { useMemo, useState } from "react";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  fileRefName,
  fileUrl,
} from "@plugins/primitives/plugins/file-viewer/core";
import {
  NoPreview,
  UnloadedFile,
  type FileRendererProps,
} from "@plugins/primitives/plugins/file-viewer/web";
import { useAssetSrc } from "@plugins/infra/plugins/endpoints/web";
import { FileTypeIcon } from "@plugins/primitives/plugins/file-type/web";
import { useSurfaceShortcuts } from "@plugins/primitives/plugins/shortcuts/web";
import type { MediaKind } from "../internal/supports";

/**
 * Whether Space landing on `target` already means something there: the media
 * element's own controls toggle playback themselves (a second toggle would
 * undo it), and a focused button is activated by Space.
 */
function spaceClaimedBy(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("video, audio, button, [role=button], a[href]") !== null
  );
}

/**
 * The browser's native player with its controls, playing as soon as it opens
 * (a browser that refuses unprompted playback leaves it paused). Space plays /
 * pauses from anywhere on the surface. The host raw route answers byte
 * ranges, so seeking streams instead of downloading the whole file. A file the
 * browser cannot decode (unsupported codec, unreadable) shows the "No preview"
 * body, with Open with default app.
 */
function MediaView(props: FileRendererProps & { kind: MediaKind }) {
  // The file's bytes over the subtree's transport (`useAssetSrc`).
  const asset = useAssetSrc(fileUrl(props.file));
  if (asset.kind !== "ready") return <UnloadedFile src={asset} />;
  return <LoadedMediaView {...props} src={asset.src} />;
}

function LoadedMediaView({
  file,
  kind,
  src,
}: FileRendererProps & { kind: MediaKind; src: string }) {
  const name = fileRefName(file);
  const [media, setMedia] = useState<HTMLMediaElement | null>(null);
  // Keyed by address so a failure on one file never sticks to the next.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const shortcuts = useMemo(
    () => [
      {
        id: "file-viewer.media.play-pause",
        keys: "space",
        label: "Play / pause",
        when: (e: KeyboardEvent) => media !== null && !spaceClaimedBy(e.target),
        handler: () => {
          if (media === null) return;
          if (media.paused) void media.play();
          else media.pause();
        },
      },
    ],
    [media],
  );
  useSurfaceShortcuts(shortcuts);

  if (failedSrc === src) return <NoPreview file={file} />;
  const common = {
    ref: setMedia,
    src,
    "aria-label": name,
    controls: true,
    autoPlay: true,
    preload: "metadata",
    onError: () => setFailedSrc(src),
  } as const;
  return (
    <Center axis="both" className="h-full p-lg">
      {kind === "video" ? (
        <video
          key={src}
          {...common}
          className="max-h-full max-w-full object-contain"
        />
      ) : (
        <Stack direction="col" align="center" gap="md" className="w-full">
          <FileTypeIcon name={name} className="size-12" />
          <Text as="p" variant="body" className="max-w-full truncate">
            {name}
          </Text>
          <audio key={src} {...common} className="w-full max-w-md" />
        </Stack>
      )}
    </Center>
  );
}

export function VideoView(props: FileRendererProps) {
  return <MediaView {...props} kind="video" />;
}

export function AudioView(props: FileRendererProps) {
  return <MediaView {...props} kind="audio" />;
}
