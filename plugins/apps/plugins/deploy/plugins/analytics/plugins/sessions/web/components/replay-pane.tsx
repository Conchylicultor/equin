import { useState, type ReactNode } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
  resolveRow,
  type ResolveResult,
} from "@plugins/primitives/plugins/pane/web";
import { useLive, rowOrStale } from "@plugins/network/plugins/live/web";
import {
  deployApp,
  deployIndexRoute,
} from "@plugins/apps/plugins/deploy/plugins/shell/core";
import { deployments } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { useManifestItemByName } from "@plugins/plugin-meta/plugins/composition/web";
import {
  isServableCompositionId,
  isServed,
  type CompositionManifestItem,
} from "@plugins/plugin-meta/plugins/composition/core";
import {
  useServeComposition,
  useServeStatus,
} from "@plugins/build/plugins/serve-composition/web";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { deploymentSessions, sessionKey, sessionOf } from "../../core";
import { ReplayPlayer, type ReplayTarget } from "./replay-player";

/**
 * One visit replayed: `replay/<site>/<visit>/<page?>` — the visit played on
 * this computer's local serve of the site's composition, from its first page
 * (or page `page`, 0-based, when opened from a page of the timeline).
 */
export const replayRoute = defineRoute({
  id: "deploy-session-replay",
  segment: "replay/:deploymentId/:visitId/:page?",
  parent: deployIndexRoute,
});

function useResolveVisit({
  deploymentId,
  visitId,
}: {
  deploymentId: string;
  visitId: string;
}): ResolveResult {
  return resolveRow(
    useLive(deploymentSessions, { id: sessionKey(deploymentId, visitId) }),
  );
}

export const replayPane = Pane.define({
  route: replayRoute,
  app: deployApp,
  component: ReplayPaneBody,
  useResolve: useResolveVisit,
  title: "Replay",
});

function ReplayPaneBody(): ReactNode {
  const { deploymentId, visitId, page } = replayPane.useParams();
  // `useResolve` gated loading / error / gone: the row is found here.
  const row = rowOrStale(
    useLive(deploymentSessions, { id: sessionKey(deploymentId, visitId) }),
  );
  const deployment = rowOrStale(useLive(deployments, { id: deploymentId }));
  const startPage = page === undefined ? 0 : Number(page);
  if (!Number.isInteger(startPage) || startPage < 0)
    throw new Error(`[sessions] replay: page "${page}" is not a page index`);
  return (
    <PaneChrome pane={replayPane}>
      {row === undefined || deployment === undefined ? (
        <Loading variant="rows" />
      ) : (
        <ServedSite compositionName={deployment.compositionId}>
          {(target) => (
            <ReplayPlayer
              // Another visit, or another start, is a fresh replay.
              key={`${row.key}/${startPage}`}
              session={sessionOf(row)}
              startPage={startPage}
              target={target}
            />
          )}
        </ServedSite>
      )}
    </PaneChrome>
  );
}

/**
 * Where the site's composition is served on this computer — what the replay
 * frames. Until it is, the pane says so and offers to serve it (the same
 * build the site page's Test locally runs).
 */
function ServedSite({
  compositionName,
  children,
}: {
  compositionName: string;
  children: (target: ReplayTarget) => ReactNode;
}): ReactNode {
  // Name → item: deploy names compositions, the serve namespace is the item's id.
  const item = useManifestItemByName(compositionName);
  if (!item)
    return (
      <Blocked
        title="This site's composition is gone"
        detail={`No composition named “${compositionName}” in the compositions config, so there is nothing to play the visit on.`}
      />
    );
  return <ServeState item={item}>{children}</ServeState>;
}

function ServeState({
  item,
  children,
}: {
  item: CompositionManifestItem;
  children: (target: ReplayTarget) => ReactNode;
}): ReactNode {
  const status = useServeStatus(item.id);
  const { setMode, rebuildNow } = useServeComposition();
  // Asked for in this pane: the build runs, and the status turns served when
  // it lands (the serve-status value is live) — until then, say so.
  const [asked, setAsked] = useState(false);
  switch (status.kind) {
    case "pending":
      return <Loading variant="rows" />;
    case "error":
      return (
        <Blocked
          title="Could not read where the site is served"
          detail={status.message}
        />
      );
    case "ready":
      break;
  }
  const serve = (): void => {
    // Mode already on with nothing served (a failed build, a reclaimed
    // namespace): writing it again builds nothing — rebuild instead.
    if (isServed(item.serve)) rebuildNow(item.id);
    else setMode(item.id, "manual");
    setAsked(true);
  };
  if (!status.live.served)
    return (
      <Blocked
        title="The site is not served on this computer"
        detail={`The replay plays the visit on a local build of ${item.name}, at ${status.host}.`}
        action={
          isServableCompositionId(item.id) ? (
            <Button onClick={serve} disabled={asked}>
              {asked ? "Building the local serve…" : "Serve locally"}
            </Button>
          ) : undefined
        }
      />
    );
  return children({
    namespace: asNamespace(status.namespace),
    host: status.host,
    url: status.url,
    rebuild: () => rebuildNow(item.id),
  });
}

function Blocked({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: ReactNode;
}): ReactNode {
  return (
    <Center axis="both" className="h-full">
      <Stack gap="sm" align="center" className="max-w-[420px] text-center">
        <Text variant="title">{title}</Text>
        <Text variant="body" tone="muted">
          {detail}
        </Text>
        {action}
      </Stack>
    </Center>
  );
}
