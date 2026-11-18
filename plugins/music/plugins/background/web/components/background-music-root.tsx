import { useEffect, type ReactNode } from "react";
import { useConfig } from "@plugins/config_v2/web";
import { PluginErrorBoundary } from "@plugins/primitives/plugins/error-boundary/web";
import { useReloadHold } from "@plugins/primitives/plugins/dom/plugins/reload-readiness/web";
import { backgroundMusicConfig } from "../../shared/config";
import { BackgroundMusic, type BackgroundMusicSource } from "../slots";
import {
  connectPages,
  setAcrossApps,
  setLabel,
  useMusicSnapshot,
} from "../internal/store";
import { gainOf, useVolume } from "../internal/volume";
import { ServiceMediaSession } from "./service-media-session";

/**
 * The service's page root: joins the browser's other pages, follows the
 * across-apps setting, and plays — here, outside every app, so the music
 * outlives the app's views — the current source's player (and, idle, every
 * source's while the panel is open).
 */
export function BackgroundMusicRoot(): ReactNode {
  const { acrossApps } = useConfig(backgroundMusicConfig);
  useEffect(() => setAcrossApps(acrossApps), [acrossApps]);
  useEffect(() => connectPages(), []);

  const sources = BackgroundMusic.Source.useContributions();
  const { state, warm } = useMusicSnapshot();
  const gain = gainOf(useVolume());
  const current = state.current;
  // The music stops with the page (and needs a gesture to start again).
  useReloadHold(current?.playing ?? false, { label: "Playback" });

  return sources.map((source) => {
    const isCurrent = current?.sourceId === source.id;
    if (!isCurrent && !warm) return null;
    return (
      <PluginErrorBoundary
        key={source.id}
        slot={BackgroundMusic.Source.id}
        label={source._pluginId ?? source.id}
      >
        <SourcePlayer
          source={source}
          playing={isCurrent && (current?.playing ?? false)}
          gain={gain}
        />
        {isCurrent ? <LabelProbe source={source} /> : null}
        {isCurrent && !source.ownsMediaSession ? (
          <ServiceMediaSession
            source={source}
            playing={current?.playing ?? false}
          />
        ) : null}
      </PluginErrorBoundary>
    );
  });
}

/** One source's player, its own component so its hook runs unconditionally. */
function SourcePlayer({
  source,
  playing,
  gain,
}: {
  source: BackgroundMusicSource;
  playing: boolean;
  gain: number;
}): ReactNode {
  const usePlayer = source.usePlayer;
  usePlayer({ playing, gain });
  return null;
}

/** Reads what the current source plays (its title, its page) for this page's button and the other pages'. */
function LabelProbe({ source }: { source: BackgroundMusicSource }): ReactNode {
  const useTitle = source.useTitle;
  const useHref = source.useHref ?? useNoHref;
  const title = useTitle();
  const href = useHref() ?? source.app.basePath;
  useEffect(
    () => setLabel(source.id, { title, href }),
    [source.id, title, href],
  );
  return null;
}

function useNoHref(): string | undefined {
  return undefined;
}
