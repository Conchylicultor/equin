import { commitDetailPane } from "@plugins/code-explorer/plugins/commit-detail/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { formatRelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { WithTooltip } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import type { CommitRow } from "@plugins/primitives/plugins/commit-list/core";
import { COMMIT_WORKTREE } from "../internal/commit-worktree";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const commitIcon = symbol("commit");

/**
 * Pure renderer, reachable ONLY on a claim — `value` is a commit the object
 * database resolved, so there is no "unknown sha" branch here and no hand-rolled
 * `<code>` fallback. When the token does not resolve, `useCommitClaim` declines
 * and the host's arbitration chain owns what renders instead.
 *
 * The chip IS the tooltip trigger: `WithTooltip` clones its child with the
 * trigger's own props and ref, and `LinkChip`'s passthrough lands both on the
 * chip's own `<button>`. This used to need a spare `Inline` wrapper to clone
 * instead, back when `LinkChip` had a closed prop surface that dropped them.
 */
export function CommitLinkChip({
  content,
  value,
}: {
  content: string;
  value: CommitRow;
}) {
  const openPane = useOpenPane();

  return (
    <WithTooltip
      content={
        <Stack gap="2xs">
          <Text as="span" variant="caption">
            {value.subject}
          </Text>
          <Text as="span" variant="caption" tone="muted">
            {value.authorName} ·{" "}
            {formatRelativeTime(new Date(value.authoredAt))}
          </Text>
        </Stack>
      }
    >
      <LinkChip
        // The FULL sha, not the abbreviation the author typed — the pane's
        // route param should name the object unambiguously.
        activation={openPane.to(
          commitDetailPane,
          { worktree: COMMIT_WORKTREE, sha: value.sha },
          { mode: "push" },
        )}
        leading={<Icon icon={commitIcon} className="text-muted-foreground" />}
        mono
      >
        {content}
      </LinkChip>
    </WithTooltip>
  );
}
