import type { ReactElement } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
  useOpenPane,
} from "@plugins/primitives/plugins/pane/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { LogsCatalog } from "./components/logs-catalog";
import { LogReader } from "./components/log-reader";
import { WorktreePicker } from "./components/worktree-picker";
import { servedWorktree } from "./internal/present";

// `;wt` names another worktree's logs (absent: this page's own), and the
// reader's `;at` an instant to read back from — so a report can link to the
// exact line its evidence is, in the worktree it happened in.
const logsRoute = defineRoute({
  id: "logs",
  segment: "logs;wt",
});

export const logsPane = Pane.define({
  title: "Logs",
  route: logsRoute,
  app: debugApp,
  component: LogsBody,
  // Wide enough beside the reader for a log's name, description and meter.
  width: 560,
});

export const logChannelPane = Pane.define({
  route: defineRoute({
    id: "logs-channel",
    segment: "ch/:channel;at",
    parent: logsRoute,
  }),
  app: debugApp,
  title: { useText: ({ channel }) => channel },
  component: LogReaderBody,
  useResolve: false,
  width: 720,
});

function useWorktree(): string | null {
  const { wt } = logsPane.useParams();
  return wt ?? servedWorktree();
}

function NoWorktree(): ReactElement {
  return (
    <>
      This page is not served under a worktree address, so it has no logs of its
      own.
    </>
  );
}

function LogsBody(): ReactElement {
  const worktree = useWorktree();
  const setParams = logsPane.useSetParams();
  const openPane = useOpenPane();
  const selected = logChannelPane.useRouteEntry()?.params.channel;
  return (
    <PaneChrome pane={logsPane}>
      {worktree === null ? (
        <NoWorktree />
      ) : (
        <>
          <WorktreePicker
            worktree={worktree}
            served={servedWorktree()}
            onPick={(wt) =>
              setParams({ wt: wt === servedWorktree() ? undefined : wt })
            }
          />
          <LogsCatalog
            worktree={worktree}
            selectedId={selected}
            onOpen={(id) =>
              openPane.to(logChannelPane, { channel: id }, { mode: "push" })
            }
          />
        </>
      )}
    </PaneChrome>
  );
}

function LogReaderBody(): ReactElement {
  const { channel, at } = logChannelPane.useParams();
  const setParams = logChannelPane.useSetParams();
  const worktree = useWorktree();
  const atMs = at === undefined ? null : Number(at);
  return (
    <PaneChrome pane={logChannelPane}>
      {worktree === null ? (
        <NoWorktree />
      ) : (
        <LogReader
          key={`${worktree}/${channel}`}
          worktree={worktree}
          log={channel}
          at={atMs !== null && Number.isFinite(atMs) ? atMs : null}
          onShowNewest={() => setParams({ channel, at: undefined })}
        />
      )}
    </PaneChrome>
  );
}
