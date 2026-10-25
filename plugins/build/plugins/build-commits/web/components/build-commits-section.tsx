import type { ReactElement } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { CommitRowItem } from "@plugins/primitives/plugins/commit-list/web";
import { OpenCommitConversation } from "@plugins/conversations/plugins/commit-conversation/web";
import { buildRunCommits } from "../../core";

const BRANCH_COLOR = "var(--primary)";

/**
 * A build's commits are about the TREE it was built from, which every one of its
 * targets shares — so there is one question and one read, whatever the run
 * built. This used to look the run up on the history resource first and
 * short-circuit a composition row with "commits belong to the parent build";
 * with one invocation now recorded as one row there is no parent to defer to,
 * and the run's own commits ARE the answer.
 */
export function BuildCommitsSection({
  runId,
}: {
  runId: string;
}): ReactElement {
  const result = useLive(buildRunCommits, { id: runId });

  if (result.status === "loading") return <Loading label="Loading commits…" />;
  if (result.status === "unavailable")
    return <Placeholder tone="muted">{result.message}</Placeholder>;
  if (result.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="this build's commits"
        error={result.error}
        refetch={result.refetch}
      />
    );
  }
  const { commits, basis, truncated } = result.data;
  if (commits.length === 0) {
    return <Placeholder>No commits in this build.</Placeholder>;
  }

  return (
    <>
      {/* A commit graph, not a record list: each row draws its own segment of
          the branch line, joined by its neighbours (`isFirst` / `isLast`). */}
      <ol>
        {commits.map((commit, idx) => (
          <CommitRowItem
            key={commit.sha}
            commit={commit}
            isFirst={idx === 0}
            isLast={idx === commits.length - 1}
            color={BRANCH_COLOR}
            actions={<OpenCommitConversation commit={commit} />}
          />
        ))}
      </ol>
      {basis === "history" ? (
        <Placeholder tone="muted">
          No earlier successful build to compare with; showing the run&apos;s
          {truncated ? ` newest ${commits.length}` : ""} commits.
        </Placeholder>
      ) : (
        truncated && (
          <Placeholder tone="muted">
            Showing the newest {commits.length} commits; older ones in this
            build are not listed.
          </Placeholder>
        )
      )}
    </>
  );
}
