import type { ReactNode } from "react";
import type { ArtifactItem } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/core";
import { useCloseArtifacts } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { afterOpen } from "@plugins/primitives/plugins/link-gesture/core";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { beforeAfterPairs, type BeforeAfterPair } from "../../core";
import { beforeAfterPane } from "../panes";
import { PairNote, SplitThumb } from "./pair-image";

/**
 * The conversation's before / after pairs in the Artifacts popover: a two-up
 * grid of split before | after thumbnails, each with its title and id. A tile
 * opens the Before / after pane on its pair beside the conversation and
 * closes the popover. An item is one `register_before_after` call (its key
 * the tool-use id); each tile reads its pair back by it.
 */
export function BeforeAfterSection({
  items,
}: {
  items: ArtifactItem[];
}): ReactNode {
  return (
    <Grid cols={2} gap="sm" className="px-row">
      {items.map((item) => (
        <PairTileOf key={item.key} toolUseId={item.key} />
      ))}
    </Grid>
  );
}

function PairTileOf({ toolUseId }: { toolUseId: string }): ReactNode {
  const result = useLive(beforeAfterPairs, { where: { toolUseId }, limit: 1 });
  if (result.status === "loading") return <Loading variant="block" />;
  if (result.status === "error")
    return (
      <ResourceErrorInline
        variant="inline"
        subject="a before / after pair"
        error={result.error}
        refetch={result.refetch}
      />
    );
  const pair = result.data[0];
  // The call is in the transcript, its pair is not (refused, or deleted).
  if (pair === undefined) return <PairNote>No pair recorded</PairNote>;
  return <PairTile pair={pair} />;
}

function PairTile({ pair }: { pair: BeforeAfterPair }): ReactNode {
  const openPane = useOpenPane();
  const close = useCloseArtifacts();
  // `push`: beside the conversation, which stays open.
  const open = afterOpen(
    openPane.to(beforeAfterPane, { pair: pair.id }, { mode: "push" }),
    close,
  );
  return (
    <Stack
      as="button"
      gap="2xs"
      className={cn(
        "group/tile text-left focus-ring rounded-md",
        yieldClass("x"),
      )}
      title={`${pair.title}\n${pair.id}`}
      {...activationProps(open)}
    >
      <Clip
        className={cn(
          "relative aspect-[16/10] w-full rounded-md bg-cover-fill",
          "ring-1 ring-border group-hover/tile:ring-primary",
        )}
      >
        <SplitThumb pair={pair} />
      </Clip>
      <Text variant="caption">{pair.title}</Text>
      <Text variant="code" tone="faint">
        {pair.id}
      </Text>
    </Stack>
  );
}
