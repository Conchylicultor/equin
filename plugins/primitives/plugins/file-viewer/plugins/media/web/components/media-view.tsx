import { useMemo, useState, type SyntheticEvent } from "react";
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
  type PreviewFailure,
} from "@plugins/primitives/plugins/file-viewer/web";
import { useAssetSrc } from "@plugins/infra/plugins/endpoints/web";
import { FileTypeIcon } from "@plugins/primitives/plugins/file-type/web";
import { usePlayPauseShortcut } from "@plugins/primitives/plugins/shortcuts/web";
import type { MediaKind } from "../internal/supports";

/**
 * The browser's native player with its controls, playing as soon as it opens
 * (a browser that refuses unprompted playback leaves it paused). Space plays /
 * pauses from anywhere on the surface (`usePlayPauseShortcut`). The host raw route answers byte
 * ranges, so seeking streams instead of downloading the whole file. A file the
 * player cannot open says why (`mediaFailure`: damaged or incomplete,
 * unreadable, an encoding the browser cannot decode — never "No preview for
 * video files", which blames the kind), with Retry and Open with default app.
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
  const [failed, setFailed] = useState<{
    src: string;
    failure: PreviewFailure;
  } | null>(null);
  // Bumped by Retry: a fresh element opens the file again (one still being
  // written may be whole by now).
  const [attempt, setAttempt] = useState(0);

  const toggle = useMemo(
    () =>
      media === null
        ? null
        : () => {
            if (media.paused) void media.play();
            else media.pause();
          },
    [media],
  );
  usePlayPauseShortcut(toggle);

  if (failed?.src === src) {
    return (
      <NoPreview
        file={file}
        failure={failed.failure}
        onRetry={() => {
          setFailed(null);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }
  const common = {
    ref: setMedia,
    src,
    "aria-label": name,
    controls: true,
    autoPlay: true,
    preload: "metadata",
    onError: (e: SyntheticEvent<HTMLMediaElement>) =>
      setFailed({ src, failure: mediaFailure(kind, e.currentTarget.error) }),
  } as const;
  return (
    <Center axis="both" className="h-full p-lg">
      {kind === "video" ? (
        <video
          key={`${src}#${attempt}`}
          {...common}
          className="max-h-full max-w-full object-contain"
        />
      ) : (
        <Stack direction="col" align="center" gap="md" className="w-full">
          <FileTypeIcon name={name} className="size-12" />
          <Text as="p" variant="body" className="max-w-full truncate">
            {name}
          </Text>
          <audio
            key={`${src}#${attempt}`}
            {...common}
            className="w-full max-w-md"
          />
        </Stack>
      )}
    </Center>
  );
}

/**
 * What the player's `MediaError` says, in words. Chromium reports a file it
 * cannot open at all — a truncated mp4 with no index (`moov`) atom, a render
 * still being written, a container or codec it lacks — as
 * SRC_NOT_SUPPORTED, so that sentence names every cause; its own message
 * (`DEMUXER_ERROR_COULD_NOT_OPEN: …`) is passed along as the technical detail.
 */
function mediaFailure(
  kind: MediaKind,
  error: MediaError | null,
): PreviewFailure {
  const noun = kind === "video" ? "video" : "audio file";
  if (error === null) {
    return {
      title: `Can't play this ${noun}`,
      detail: "The player failed without saying why.",
    };
  }
  const technical = error.message === "" ? undefined : error.message;
  switch (error.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return {
        title: `Loading this ${noun} stopped`,
        detail: "The player stopped fetching the file before it could open.",
        technical,
      };
    case MediaError.MEDIA_ERR_NETWORK:
      return {
        title: `Couldn't read this ${noun}`,
        detail:
          "Reading the file from the computer failed partway — it may have been moved, deleted or changed while loading.",
        technical,
      };
    case MediaError.MEDIA_ERR_DECODE:
      return {
        title: `Can't play this ${noun}`,
        detail:
          "The file opened, but its data could not be decoded — it is likely damaged.",
        technical,
      };
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return {
        title: `Can't open this ${noun}`,
        detail:
          "The browser could not read this file. It may be incomplete or damaged (for example, an export that was interrupted or is still being written), or use an encoding the browser does not support.",
        technical,
      };
    default:
      return {
        title: `Can't play this ${noun}`,
        detail: `The player failed with an unknown error (code ${error.code}).`,
        technical,
      };
  }
}

export function VideoView(props: FileRendererProps) {
  return <MediaView {...props} kind="video" />;
}

export function AudioView(props: FileRendererProps) {
  return <MediaView {...props} kind="audio" />;
}
