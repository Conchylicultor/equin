import type { ReactElement } from "react";
import { useEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { CommitRowItem } from "@plugins/primitives/plugins/commit-list/web";
import { OpenCommitConversation } from "@plugins/conversations/plugins/commit-conversation/web";
import { getBuildRunCommits } from "../../shared";

const BRANCH_COLOR = "var(--primary)";

/**
 * A build's commits are about the TREE it was built from, which every one of its
 * targets shares — so there is one question and one fetch, whatever the run
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
  const { data, isPending, isError } = useEndpoint(getBuildRunCommits, {
    id: runId,
  });

  if (isPending) return <Loading label="Loading commits…" />;
  if (isError)
    return <Placeholder tone="error">Failed to load commits.</Placeholder>;
  if (data.length === 0) {
    return <Placeholder>No commits in this build.</Placeholder>;
  }

  return (
    <ol>
      {data.map((commit, idx) => (
        <CommitRowItem
          key={commit.sha}
          commit={commit}
          isFirst={idx === 0}
          isLast={idx === data.length - 1}
          color={BRANCH_COLOR}
          actions={<OpenCommitConversation commit={commit} />}
        />
      ))}
    </ol>
  );
}
