import { NewTabButton } from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";
import {
  commitTrailer,
  type CommitRow,
} from "@plugins/primitives/plugins/commit-list/core";
import { CONVERSATION_TRAILER_KEY } from "@plugins/tasks/plugins/tasks-core/core";
import { conversationRoute } from "@plugins/conversations/core";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";

/**
 * A commit row action: open the conversation that wrote this commit — named by
 * its `Singularity-Conversation` trailer — in a new browser tab, leaving the
 * surface the commit is listed on (a popover, a build's detail) where it is.
 *
 * Nothing for a commit no conversation wrote (a hand commit, a `--from-main`
 * push, an upstream merge): there is no destination to offer.
 */
export function OpenCommitConversation({ commit }: { commit: CommitRow }) {
  const convId = commitTrailer(commit, CONVERSATION_TRAILER_KEY);
  if (convId === null) return null;
  return (
    <NewTabButton
      href={conversationRoute.link(agentManagerApp, { convId })}
      label="Open the conversation in a new tab"
    />
  );
}
