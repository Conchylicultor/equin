import {
  PaneIconAction,
  useOpenPane,
} from "@plugins/primitives/plugins/pane/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import { useAttemptSourceUrl } from "@plugins/tasks/plugins/task-source-url/web";
import { linkGestureProps } from "@plugins/primitives/plugins/link-gesture/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { opsHistory } from "@plugins/debug/plugins/profiling/plugins/op-log/plugins/op-store/core";
import { useConfig } from "@plugins/config_v2/web";
import { appPreviewPane, appPreviewUrl } from "../app-preview-pane";
import { openAppConfig } from "../../shared/config";

const rocketLaunchIcon = symbol("rocket-launch");

export function OpenAppButton() {
  const { convId } = conversationPane.useParams();
  const conversation = useConversationById(convId);
  if (!conversation) return null;
  return <OpenAppAction attemptId={conversation.attemptId} />;
}

function OpenAppAction({ attemptId }: { attemptId: string }) {
  const source = useAttemptSourceUrl(attemptId);
  const openPane = useOpenPane();
  const { target } = useConfig(openAppConfig);
  if (source.status === "error") throw source.error;
  // Has this worktree ever deployed? Its latest successful build op — one row
  // is enough, and the op-store pushes the next one the moment it lands, so
  // the button enables itself when the agent's first build succeeds.
  const builds = useLive(opsHistory, {
    where: { opSlug: attemptId, kind: "build", outcome: "success" },
    limit: 1,
  });
  if (builds.status === "error") throw builds.error;
  const built = builds.status === "ready" && builds.data.length > 0;
  // No computer behind this app (the in-browser demo): nothing is built or
  // served, and the build history is not readable — disabled, saying why.
  const label =
    builds.status === "unavailable"
      ? builds.message
      : builds.status === "ready" && !built
        ? "Open app — not built yet"
        : "Open app";
  return (
    <PaneIconAction
      label={label}
      icon={rocketLaunchIcon}
      // Pending until we know whether the task was filed from a page: opening
      // `/` meanwhile would be a guess the click cannot take back.
      loading={source.status === "loading" || builds.status === "loading"}
      // Nothing is served at the namespace until its first build deploys it.
      disabled={!built}
      // Plain click opens the app where the setting says (a browser tab by
      // default, or framed beside the chat); ⌘/middle-click takes the other way.
      {...linkGestureProps(({ elsewhere }) => {
        const path = sourcePath(
          source.status === "ready" ? source.data.url : null,
        );
        // The gesture's "elsewhere" flips the configured default — which is
        // why this is the low-level form: elsewhere is not always a browser tab.
        const inTab = (target === "new-tab") !== elsewhere;
        if (inTab) window.open(appPreviewUrl(attemptId, path), "_blank");
        else openPane(appPreviewPane, { attemptId, path }, { mode: "push" });
      })}
    />
  );
}

/**
 * The route of the page the task was filed from — path, query and hash, with
 * its host dropped: that page was on whichever namespace the user was
 * browsing (usually main), and we open the same route on the agent's own.
 * `undefined` is the app root.
 */
function sourcePath(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const parsed = new URL(url);
  const path = parsed.pathname + parsed.search + parsed.hash;
  return path === "/" ? undefined : path;
}
