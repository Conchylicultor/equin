import { useContext, type ReactNode } from "react";
import {
  SurfaceChromeContext,
  useReservesFloatingBar,
} from "@plugins/primitives/plugins/pane/web";
import { Glass } from "@plugins/apps/plugins/sonata/plugins/primitives/plugins/glass/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useCurrentSong } from "../use-current-song";
import { HEADER_HEIGHT } from "../internal/player-geometry";
import { BackToLibrary } from "./player-toolbar-items";
import { SongTitle } from "./song-title-field";

/**
 * The player's header band, floating over the top of the notes: identity on
 * the left — the app launcher (when the surface hands one down), back to the
 * library, the song's title over its composer — and on the right ONE glass
 * pill holding `tools` — the pane's `sonataPlayerPane.Actions` contributions
 * (the display switcher, then the playback tools, then full screen), in the
 * slot's reorder order (`config/apps/sonata/library/sonata-player.actions.jsonc`).
 *
 * It stands in for the pane header, so it takes over the header's two
 * surface-edge duties: the leading control, and — at the surface's top-right
 * corner — the global floating bar's safe area and anchor.
 *
 * The band itself is click-through: only its title and its pill take the
 * pointer, so the notes under the rest of it stay draggable.
 */
export function PlayerHeader({ tools }: { tools: ReactNode }) {
  const { contentOwnsTopChrome, leadingControl } =
    useContext(SurfaceChromeContext);
  const reservesFloatingBar = useReservesFloatingBar();
  return (
    <Line
      className={cn(
        "pointer-events-none gap-sm pl-md",
        reservesFloatingBar
          ? "pr-floating-bar-pane anchor-floating-bar-band"
          : "pr-md",
      )}
      style={{ height: HEADER_HEIGHT }}
    >
      <ControlSizeProvider size="lg">
        <Line className={cn("pointer-events-auto gap-2xs", yieldClass("x"))}>
          {contentOwnsTopChrome && leadingControl != null
            ? leadingControl
            : null}
          <BackToLibrary />
          <TitleBlock />
        </Line>
      </ControlSizeProvider>
      <Fill />
      <Glass className={cn("p-2xs", rigidClass())}>
        <Line className="gap-2xs">{tools}</Line>
      </Glass>
    </Line>
  );
}

/** The song's title (inline-editable) over its composer. */
function TitleBlock() {
  const current = useCurrentSong();
  const composer =
    current.status === "ready" && current.found ? current.row.composer : null;
  return (
    <Stack gap="none" className={yieldClass("x")}>
      <SongTitle appearance="heading" />
      {composer ? (
        <Text variant="caption" tone="muted">
          {composer}
        </Text>
      ) : null}
    </Stack>
  );
}
