import { useConfigResult, useSetConfig } from "@plugins/config_v2/web";
import { useAppLinkProps } from "@plugins/apps-core/plugins/tabs/web";
import { AppIconTile } from "@plugins/apps-core/plugins/app-icon/web";
import { appIcon } from "@plugins/apps-core/plugins/app-icon/core";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Slider } from "@plugins/primitives/plugins/css/plugins/slider/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { backgroundMusicConfig } from "../../shared/config";
import { nowPlaying, type NowPlaying } from "../../shared/protocol";
import { BackgroundMusic, type BackgroundMusicSource } from "../slots";
import { command, dispatch, useMusicSnapshot } from "../internal/store";
import { setVolume, useVolume } from "../internal/volume";
import { Equalizer } from "./equalizer";

const playIcon = symbol("play-arrow");
const pauseIcon = symbol("pause");
const stopIcon = symbol("stop");
const volumeOffIcon = symbol("volume-off");
const volumeDownIcon = symbol("volume-down");
const volumeUpIcon = symbol("volume-up");

function tileOf(source: BackgroundMusicSource) {
  return appIcon(source.app.icon, { color: source.app.iconColor });
}

/** Pause / resume / stop what plays — on this page, or on the page playing it. */
function control(now: NowPlaying, cmd: "pause" | "resume" | "stop") {
  if (now.where === "here") dispatch({ kind: cmd });
  else command(now.pageId, cmd);
}

/**
 * The music button's panel: what plays (with its app, play / pause, the
 * volume and stop), the music each app offers, and whether music keeps playing
 * across apps.
 */
export function MusicPanel({ onLeave }: { onLeave: () => void }) {
  const { state, titles } = useMusicSnapshot();
  const sources = BackgroundMusic.Source.useContributions();
  const now = nowPlaying(state);
  const source = now ? sources.find((s) => s.id === now.sourceId) : undefined;
  const title =
    now?.where === "remote"
      ? now.title
      : now
        ? titles.get(now.sourceId)
        : undefined;

  return (
    <ControlPanel aria-label="Background music">
      <ControlPanel.Section label="Now playing">
        {now && source ? (
          <NowPlayingCard
            now={now}
            source={source}
            title={title ?? ""}
            onLeave={onLeave}
          />
        ) : (
          <ControlPanel.Empty>Nothing playing</ControlPanel.Empty>
        )}
      </ControlPanel.Section>
      {sources.length > 0 ? (
        <ControlPanel.Section label="From your apps">
          {sources.map((s) => (
            <SourceRow
              key={s.id}
              source={s}
              playing={
                state.current?.sourceId === s.id && state.current.playing
              }
            />
          ))}
        </ControlPanel.Section>
      ) : null}
      <ControlPanel.Section>
        <AcrossAppsRow />
      </ControlPanel.Section>
    </ControlPanel>
  );
}

function NowPlayingCard({
  now,
  source,
  title,
  onLeave,
}: {
  now: NowPlaying;
  source: BackgroundMusicSource;
  title: string;
  onLeave: () => void;
}) {
  const appLinkProps = useAppLinkProps();
  const volume = useVolume();
  const link = appLinkProps(source.app.basePath);
  return (
    <Stack gap="sm">
      <Stack direction="row" gap="md" align="center">
        <AppIconTile
          icon={tileOf(source)}
          appId={source.app.id}
          className="size-12"
        />
        <Fill>
          <Stack gap="none">
            <Text variant="label" tone="strong">
              {title}
            </Text>
            <Text variant="caption" tone="muted">
              {source.kind} ·{" "}
              <a
                {...link}
                onClick={(e) => {
                  link.onClick?.(e);
                  onLeave();
                }}
                className="underline-offset-2 hover:underline"
              >
                {source.app.name}
              </a>
              {now.where === "remote" ? " · in another tab" : null}
            </Text>
          </Stack>
        </Fill>
      </Stack>
      <Stack direction="row" gap="xs" align="center">
        <IconButton
          icon={now.playing ? pauseIcon : playIcon}
          label={now.playing ? "Pause" : "Play"}
          onClick={() => control(now, now.playing ? "pause" : "resume")}
        />
        <Icon
          icon={
            volume === 0
              ? volumeOffIcon
              : volume < 0.5
                ? volumeDownIcon
                : volumeUpIcon
          }
        />
        <Fill>
          <Slider
            value={volume}
            min={0}
            max={1}
            step={0.01}
            onValueChange={setVolume}
            aria-label="Volume"
          />
        </Fill>
        <IconButton
          icon={stopIcon}
          label="Stop"
          onClick={() => control(now, "stop")}
        />
      </Stack>
    </Stack>
  );
}

/** One app's music: click to play it here (taking over), or to pause it. */
function SourceRow({
  source,
  playing,
}: {
  source: BackgroundMusicSource;
  playing: boolean;
}) {
  const useTitle = source.useTitle;
  const title = useTitle();
  return (
    <ControlPanel.Row
      icon={
        <AppIconTile
          icon={tileOf(source)}
          appId={source.app.id}
          className="size-5"
        />
      }
      hint={`${source.app.name} · ${source.kind}`}
      trailing={playing ? <Equalizer on /> : source.app.name}
      onSelect={() =>
        dispatch(
          playing ? { kind: "pause" } : { kind: "play", sourceId: source.id },
        )
      }
    >
      {title}
    </ControlPanel.Row>
  );
}

function AcrossAppsRow() {
  const config = useConfigResult(backgroundMusicConfig);
  const setConfig = useSetConfig(backgroundMusicConfig);
  return foldResource(config, {
    loading: () => <Loading variant="text" />,
    error: (error) => {
      throw error;
    },
    ready: ({ acrossApps }) => (
      <ControlPanel.Row
        select="switch"
        checked={acrossApps}
        hint="Off, leaving the app stops its music. Clicking between windows on the desktop never does."
        onSelect={() => setConfig("acrossApps", !acrossApps)}
      >
        Keep playing across apps
      </ControlPanel.Row>
    ),
  });
}
