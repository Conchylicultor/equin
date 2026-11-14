import { useMemo, type ReactNode } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
  resolveRow,
  type ResolveResult,
} from "@plugins/primitives/plugins/pane/web";
import { useLive, rowOrStale } from "@plugins/network/plugins/live/web";
import { deployApp } from "@plugins/apps/plugins/deploy/plugins/shell/core";
import { siteRoute } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { Apps } from "@plugins/apps-core/web";
import { sitePane } from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import type { Session } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { deploymentSessions, sessionKey, sessionOf } from "../../core";
import { localPathOf } from "../internal/local-path";
import { ReplayPlayer } from "./replay-player";

/**
 * One visit replayed, as a side pane of its site:
 * `site/<site>/<tab?>/replay/<visit>/<page?>` — the visit played on THIS
 * instance's own app (the site renders the same apps under the same paths),
 * from its first page (or page `page`, 0-based, when opened from a page of
 * the timeline).
 */
export const replayRoute = defineRoute({
  id: "deploy-session-replay",
  segment: "replay/:visitId/:page?",
  parent: siteRoute,
});

/** The visit, keyed by the site (the parent pane's param) and its own id. */
function useResolveVisit(): ResolveResult {
  // A pane's params are its own: the site is its parent's.
  const { deploymentId } = sitePane.useParams();
  const { visitId } = replayPane.useParams();
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
  const { deploymentId } = sitePane.useParams();
  const { visitId, page } = replayPane.useParams();
  // `useResolve` gated loading / error / gone: the row is found here.
  const row = rowOrStale(
    useLive(deploymentSessions, { id: sessionKey(deploymentId, visitId) }),
  );
  const startPage = page === undefined ? 0 : Number(page);
  if (!Number.isInteger(startPage) || startPage < 0)
    throw new Error(`[sessions] replay: page "${page}" is not a page index`);
  return (
    <PaneChrome pane={replayPane}>
      {row === undefined ? (
        <Loading variant="rows" />
      ) : (
        <LocalReplay
          // Another visit, or another start, is a fresh replay.
          key={`${row.key}/${startPage}`}
          session={sessionOf(row)}
          startPage={startPage}
        />
      )}
    </PaneChrome>
  );
}

/**
 * The visit played on this instance's apps: each recorded page moved to
 * where it lives here (a former base path to the app's current one). A page
 * no app here owns cannot be played — the pane says which.
 */
function LocalReplay({
  session,
  startPage,
}: {
  session: Session;
  startPage: number;
}): ReactNode {
  const entries = Apps.App.useContributions();
  const apps = useMemo(() => entries.map((e) => e.app), [entries]);
  const missing = session.hits
    .filter((h) => h.kind === "pageview")
    .map((h) => h.path)
    .find((p) => localPathOf(p, apps) === null);
  if (missing !== undefined)
    return (
      <Blocked
        title="This instance has no app for this visit"
        detail={`The visitor opened ${missing}, which no app here serves, so there is nothing to play the visit on.`}
      />
    );
  return (
    <ReplayPlayer
      session={session}
      startPage={startPage}
      localPath={(p) => localPathOf(p, apps) ?? p}
    />
  );
}

function Blocked({
  title,
  detail,
}: {
  title: string;
  detail: string;
}): ReactNode {
  return (
    <Center axis="both" className="h-full">
      <Stack gap="sm" align="center" className="max-w-[420px] text-center">
        <Text variant="title">{title}</Text>
        <Text variant="body" tone="muted">
          {detail}
        </Text>
      </Stack>
    </Center>
  );
}
