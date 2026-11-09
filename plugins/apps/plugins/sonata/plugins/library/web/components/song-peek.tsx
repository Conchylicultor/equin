import type { ReactNode } from "react";
import { rowOrStale, useLive } from "@plugins/network/plugins/live/web";
import { useDeferredLoadComplete } from "@plugins/framework/plugins/web-sdk/core";
import {
  PaneEndControls,
  PaneHeaderCell,
} from "@plugins/primitives/plugins/pane/web";
import { matchResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import { SonataMiniPlayer } from "@plugins/apps/plugins/sonata/plugins/mini-player/web";
import { Glass } from "@plugins/apps/plugins/sonata/plugins/primitives/plugins/glass/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { songIdKind, songLibrary } from "../../core";
import { SongHydrator } from "../song-hydrator";
import { songPeekPane } from "../panes";

/**
 * The song peek: one library song in Sonata's mini player, filling the whole
 * pane — a column beside whatever named it (a transcript's song chip). Its
 * chrome is drawn the way the Sonata player draws its own, over the notes: the
 * title on the left, and at the right ONE glass pill holding the pane's
 * `songPeekPane.Actions` (the speed wheel, volume) then the pane's standard
 * Expand ("Open in Sonata", the full player) and close.
 *
 * Hydrated like the player: every source's raw collected through the
 * `Library.Source` registry once the deferred tier (where most sources load)
 * has settled; a source still preparing the song shows its own Body instead.
 */
export function SongPeek(): ReactNode {
  const { songId: songIdParam } = songPeekPane.useParams();
  const songId = songIdKind.key(songIdParam);
  const deferredComplete = useDeferredLoadComplete();
  if (!deferredComplete) return <Loading />;
  return (
    <SongHydrator songId={songId}>
      {(hydration) =>
        matchResource(hydration, {
          loading: () => <Loading />,
          error: (error) => (
            <Inset pad="lg">
              <ResourceErrorInline
                error={error}
                refetch={hydration.refetch}
                variant="block"
              />
            </Inset>
          ),
          ready: (h) => {
            if (h.kind === "awaiting-owner") return <Loading />;
            if (h.pending.length > 0) {
              return (
                <Inset pad="lg">
                  <Stack direction="col" gap="lg">
                    {h.pending.map(({ sourceId, label, Body }) => (
                      <Stack key={sourceId} direction="col" gap="sm">
                        <Text variant="label" tone="muted">
                          {label}
                        </Text>
                        <Body songId={songId} />
                      </Stack>
                    ))}
                  </Stack>
                </Inset>
              );
            }
            return (
              <SonataMiniPlayer
                identity={{ kind: "library", songId }}
                rawById={h.rawMap}
                header={<SongPeekHeader songId={songId} />}
              />
            );
          },
        })
      }
    </SongHydrator>
  );
}

/**
 * The peek's header band: the song's title over its composer on the left,
 * straight on the notes; the glass pill of tools and the pane's own Expand and
 * close on the right. Click-through but for those two, so the notes under the
 * rest of it stay draggable.
 */
function SongPeekHeader({ songId }: { songId: string }) {
  const song = rowOrStale(useLive(songLibrary, { id: songId }));
  return (
    <Line className="pointer-events-none h-full gap-sm pr-sm pl-md">
      <Stack gap="none" className={cn("pointer-events-auto", yieldClass("x"))}>
        {song === undefined ? (
          <Loading variant="block" className="h-5 w-40" />
        ) : (
          <>
            <Text variant="subheading" className="truncate font-bold">
              {song.title}
            </Text>
            {song.composer ? (
              <Text variant="caption" tone="muted" className="truncate">
                {song.composer}
              </Text>
            ) : null}
          </>
        )}
      </Stack>
      <Fill />
      <Glass className={cn("pointer-events-auto p-2xs", rigidClass())}>
        <ControlSizeProvider size="md">
          <Line className="gap-2xs">
            {/* The pane's own title item is hidden by the slot's config: the
                band draws the title itself, on the left. */}
            <songPeekPane.Actions.Render>
              {(item) => <PaneHeaderCell {...item} />}
            </songPeekPane.Actions.Render>
            <PaneEndControls pane={songPeekPane} />
          </Line>
        </ControlSizeProvider>
      </Glass>
    </Line>
  );
}
