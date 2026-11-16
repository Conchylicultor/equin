import type { ReactNode } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
  PaneMessage,
} from "@plugins/primitives/plugins/pane/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { CommitDiffView } from "./components/commit-diff-view";
import { CommitMessage } from "./components/commit-message";
import { useCommitInfo } from "./use-commit-info";

export const commitDetailPane = Pane.define({
  route: defineRoute({
    id: "commit-detail",
    segment: "commit/:worktree/:sha",
  }),
  app: agentManagerApp,
  // `Commit <shortSha>`: the subject now heads the body (CommitMessage), so
  // the title names the object. The resolved short sha (git's abbreviation)
  // once known; the param's first seven while loading, unknown or unreachable
  // — a metadata failure must not cost the pane its identity.
  title: {
    useText: useCommitTitleText,
    fallback: ({ sha }) => `Commit ${shortSha(sha)}`,
    component: CommitTitle,
  },
  component: CommitDetailBody,
  chrome: { history: false },
  // A git sha is not an app entity the router can validate.
  useResolve: false,
});

function CommitDetailBody() {
  // Both params come from this pane's own route entry — no ancestor
  // conversation lookup, which is what lets any surface push it.
  const { worktree, sha } = commitDetailPane.useParams();
  const info = useCommitInfo(worktree, sha);

  if (info.kind === "not-found" || info.kind === "unavailable") {
    return (
      <PaneChrome pane={commitDetailPane}>
        <PaneMessage>
          <Placeholder>
            {info.kind === "not-found" ? info.reason : info.message}
          </Placeholder>
        </PaneMessage>
      </PaneChrome>
    );
  }
  return (
    <PaneChrome pane={commitDetailPane}>
      {/* One scroll for the whole pane (PaneChrome's): the message scrolls
          away, the file list's toolbar pins at the top, an open file's row
          pins under it while its diff scrolls. */}
      <Stack gap="none">
        {info.kind === "found" && <CommitMessage commit={info.commit} />}
        <CommitDiffView worktree={worktree} sha={sha} />
      </Stack>
    </PaneChrome>
  );
}

function useCommitTitleText({
  worktree,
  sha,
}: {
  worktree: string;
  sha: string;
}): string | undefined {
  const info = useCommitInfo(worktree, sha);
  return info.kind === "found" ? `Commit ${info.commit.shortSha}` : undefined;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

// The header's title: "Commit" and the short sha set in mono, then the
// standard copy button for the full sha — the same cached commit read the tab
// title's `useCommitTitleText` makes.
function CommitTitle(): ReactNode {
  const { worktree, sha } = commitDetailPane.useParams();
  const info = useCommitInfo(worktree, sha);
  const found = info.kind === "found";
  const short = found ? info.commit.shortSha : shortSha(sha);
  const full = found ? info.commit.sha : sha;
  return (
    <Inline gap="2xs">
      {/* One inline box: the pane header lays a title node out as a flex
          row, where the space between two sibling text items would collapse. */}
      <span>
        Commit <span className="font-mono">{short}</span>
      </span>
      <CopyButton text={full} tooltip={`Copy ${full}`} />
    </Inline>
  );
}
