import type { ReactNode } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { CommitDiffView } from "./components/commit-diff-view";
import { useCommitInfo } from "./use-commit-info";

export const commitDetailPane = Pane.define({
  route: defineRoute({
    id: "commit-detail",
    segment: "commit/:worktree/:sha",
  }),
  app: agentManagerApp,
  // The subject once resolved; the short sha while loading, unknown, or
  // unreachable — a metadata failure must not cost the pane its identity.
  title: {
    useText: useCommitSubject,
    fallback: ({ sha }) => shortSha(sha),
    component: CommitTitle,
  },
  component: CommitDetailBody,
  chrome: { history: false },
  width: 720,
  // A git sha is not an app entity the router can validate.
  useResolve: false,
});

function CommitDetailBody() {
  // Both params come from this pane's own route entry — no ancestor
  // conversation lookup, which is what lets any surface push it.
  const { worktree, sha } = commitDetailPane.useParams();
  const info = useCommitInfo(worktree, sha);

  return (
    <PaneChrome pane={commitDetailPane}>
      {info.kind === "not-found" ? (
        <Placeholder>{info.reason}</Placeholder>
      ) : info.kind === "unavailable" ? (
        <Placeholder>{info.message}</Placeholder>
      ) : (
        <CommitDiffView worktree={worktree} sha={sha} />
      )}
    </PaneChrome>
  );
}

function useCommitSubject({
  worktree,
  sha,
}: {
  worktree: string;
  sha: string;
}): string | undefined {
  const info = useCommitInfo(worktree, sha);
  return info.kind === "found" ? info.commit.subject : undefined;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

// The header's title: the subject, or the short sha set in mono — the same
// cached commit read the tab title's `useCommitSubject` makes.
function CommitTitle(): ReactNode {
  const { worktree, sha } = commitDetailPane.useParams();
  const info = useCommitInfo(worktree, sha);
  if (info.kind === "found") return info.commit.subject;
  return <span className="font-mono">{shortSha(sha)}</span>;
}
