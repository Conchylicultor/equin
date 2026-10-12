import { useMemo } from "react";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { historyVersion } from "@plugins/history/plugins/engine/core";
import { pageBlocks } from "@plugins/page/plugins/editor/core";
import { BLOCK_INSET, PageIcon } from "@plugins/page/plugins/editor/web";
import { ReadOnlyBlocks } from "@plugins/page/plugins/read-only-view/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  buildForest,
  buildDiff,
  type PageSnapshot,
} from "../internal/build-diff";
import { isEmoji } from "@plugins/ui/plugins/icons/plugins/emoji/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const descriptionIcon = symbol("description");

/**
 * Faithful read-only preview of one page version, with per-block diff
 * highlighting against the current page. Reads the version's snapshot (live:
 * a version still inside its merge window is coalesced into, and retention
 * removes old ones) and the live current blocks; the snapshot is rendered via `ReadOnlyBlocks`
 * with a diff map computed by stable id then content fallback (see build-diff).
 */
export function PageVersionPreview({
  pageId,
  versionId,
}: {
  pageId: string;
  versionId: string;
}) {
  const version = useLive(historyVersion, {
    sourceId: "pages",
    entityId: pageId,
    versionId,
  });
  const current = useLive(pageBlocks, { pageId });

  // Gate on both async sources: the diff requires the current blocks settled,
  // and collapsing `pending` into `[]` would render a confidently-wrong diff
  // during the load window (banned by live-state/no-pending-data-collapse).
  if (version.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="this version"
        error={version.error}
        refetch={version.refetch}
      />
    );
  }
  if (current.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="the current page"
        error={current.error}
        refetch={current.refetch}
      />
    );
  }
  if (version.status === "loading" || current.status === "loading") {
    return <Loading variant="rows" count={6} />;
  }

  return (
    <VersionPreview
      pageId={pageId}
      snap={version.data.snapshot as PageSnapshot}
      currentBlocks={current.data}
    />
  );
}

function VersionPreview({
  pageId,
  snap,
  currentBlocks,
}: {
  pageId: string;
  snap: PageSnapshot;
  currentBlocks: Parameters<typeof buildDiff>[1];
}) {
  const forest = useMemo(
    () => buildForest(snap.blocks, pageId),
    [snap, pageId],
  );
  const diff = buildDiff(snap.blocks, currentBlocks);

  const savedIcon = snap.page.icon;
  const icon =
    typeof savedIcon === "string" && isEmoji(savedIcon) ? savedIcon : null;

  return (
    <Stack gap="md">
      {/* Icon + title are chrome, not blocks: they sit on the block content
          edge (`C + BLOCK_INSET`), while `ReadOnlyBlocks` stays flush at `C`. */}
      <Inset x={BLOCK_INSET}>
        <Line className="gap-sm">
          <PageIcon icon={icon} fallback={descriptionIcon} className="size-6" />
          <Text as="h2" variant="title">
            {snap.page.title || "Untitled"}
          </Text>
        </Line>
      </Inset>
      {forest.length > 0 ? (
        <ReadOnlyBlocks forest={forest} diff={diff} />
      ) : (
        <Placeholder tone="muted">This version had no content.</Placeholder>
      )}
    </Stack>
  );
}
