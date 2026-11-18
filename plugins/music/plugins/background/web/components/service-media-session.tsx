import type { ReactNode } from "react";
import {
  appIconFile,
  getAppIconPng,
} from "@plugins/apps-core/plugins/app-manifest/core";
import { assetPath } from "@plugins/infra/plugins/endpoints/core";
import { useMediaSession } from "@plugins/media/plugins/media-session/web";
import type { BackgroundMusicSource } from "../slots";
import { dispatch, useMusicSnapshot } from "../internal/store";

/**
 * The current source in the browser's media session (Chrome's media controls,
 * the OS media keys): what it plays, its app's name and icon, and play / pause
 * / stop driving the service as the music button does.
 */
export function ServiceMediaSession({
  source,
  playing,
}: {
  source: BackgroundMusicSource;
  playing: boolean;
}): ReactNode {
  const { labels } = useMusicSnapshot();
  const title = labels.get(source.id)?.title ?? "";
  useMediaSession({
    title: title === "" ? source.kind : title,
    artist: source.app.name,
    artwork: [
      {
        asset: assetPath(getAppIconPng, {
          appId: source.app.id,
          file: appIconFile(512),
        }),
        sizes: "512x512",
        type: "image/png",
      },
    ],
    playing,
    actions: {
      play: () => dispatch({ kind: "resume" }),
      pause: () => dispatch({ kind: "pause" }),
      stop: () => dispatch({ kind: "stop" }),
    },
  });
  return null;
}
