import type { ReactElement } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
  resolveRow,
  useOpenPane,
  type ResolveResult,
} from "@plugins/primitives/plugins/pane/web";
import { useLive, rowOrStale } from "@plugins/network/plugins/live/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { claudeCliCalls } from "@plugins/infra/plugins/claude-cli/core";
import { ClaudeCliCallDetail } from "@plugins/infra/plugins/claude-cli/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { CallsView } from "./components/calls-view";

const callsRoute = defineRoute({
  id: "claude-cli-calls",
  segment: "claude-cli-calls",
});

const callDetailRoute = defineRoute({
  // Pane segment patterns are globally unique: `cli-call/` names this pane alone.
  id: "claude-cli-call-detail",
  segment: "cli-call/:callId",
  parent: callsRoute,
});

export const claudeCliCallsPane = Pane.define({
  title: "Claude CLI Calls",
  route: callsRoute,
  app: debugApp,
  component: CallsBody,
});

function useResolveCall({ callId }: { callId: string }): ResolveResult {
  // The by-id row read (`claude-cli-calls:rows`) — found whatever the call's
  // position in the log, missing once the recorder's trim has dropped it.
  return resolveRow(useLive(claudeCliCalls, { id: callId }));
}

/** The call's source once it is read; the pane falls back to "Call" until then. */
function useCallTitle({ callId }: { callId: string }): string | undefined {
  return rowOrStale(useLive(claudeCliCalls, { id: callId }))?.sourceName;
}

export const claudeCliCallDetailPane = Pane.define({
  route: callDetailRoute,
  app: debugApp,
  title: { useText: useCallTitle, fallback: "Call" },
  component: CallDetailBody,
  useResolve: useResolveCall,
});

function CallsBody(): ReactElement {
  const openPane = useOpenPane();
  const selectedId = claudeCliCallDetailPane.useRouteEntry()?.params.callId;
  return (
    <PaneChrome pane={claudeCliCallsPane}>
      <CallsView
        selectedId={selectedId}
        linkTo={(callId) =>
          openPane.to(claudeCliCallDetailPane, { callId }, { mode: "push" })
        }
      />
    </PaneChrome>
  );
}

function CallDetailBody(): ReactElement {
  const { callId } = claudeCliCallDetailPane.useParams();
  // The resolve guard answered "does this call exist" before this body
  // mounted; a failed re-read keeps the row as last seen (`rowOrStale`).
  const call = rowOrStale(useLive(claudeCliCalls, { id: callId }));
  return (
    <PaneChrome pane={claudeCliCallDetailPane}>
      {call !== undefined ? (
        <Scroll axis="y" fill>
          <Inset pad="md">
            <ClaudeCliCallDetail call={call} />
          </Inset>
        </Scroll>
      ) : (
        <Loading />
      )}
    </PaneChrome>
  );
}
