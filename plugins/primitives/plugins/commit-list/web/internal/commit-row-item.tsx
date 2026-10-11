import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  cn,
  useControlSize,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  RowActions,
  rowActionsAnchor,
} from "@plugins/primitives/plugins/row-actions/web";
import type React from "react";
import type { CommitRow } from "../../core";
import { CommitRail, commitRowHeight } from "./commit-rail";

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 14) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Who wrote it and exactly when — the two facts the row no longer spends width
 * on, said on hover of the one leaf that is about time anyway.
 *
 * The author used to have its own column, hidden below the `sm:` VIEWPORT
 * breakpoint — a window-width test deciding the layout of a 480px popover, so
 * it never fired where it was needed. Rather than teach the row a second width
 * axis, the column is gone: this is a single-user app (one instance per user),
 * so a chain of a checkout's own commits carries the same name on every row,
 * and the row's real content — the subject — is what that width was owed to.
 */
function whenTitle(commit: CommitRow): string {
  const t = new Date(commit.authoredAt);
  const when = Number.isNaN(t.getTime()) ? null : t.toLocaleString();
  return when === null ? commit.authorName : `${commit.authorName} · ${when}`;
}

export function CommitRowItem({
  commit,
  isFirst,
  isLast,
  color,
  pushed = false,
  markers,
  actions,
  onClick,
}: {
  commit: CommitRow;
  isFirst: boolean;
  isLast: boolean;
  color: string;
  pushed?: boolean;
  /**
   * Free-form chips pinned to this commit — "who is sitting on this commit".
   * The general form of `pushed`, which is one such marker hard-coded; both are
   * rendered, in their own track between the subject and the timestamp.
   *
   * The caller owns the grouping (a `<Inline gap="2xs" className={rigidClass()}>`
   * of `<Badge>`s is the usual shape), so a row can carry one marker or five
   * without this primitive learning anything about what they mean.
   */
  markers?: React.ReactNode;
  /**
   * Hover-revealed actions on this commit (plain `IconButton`s) — what a host
   * can DO with it, as opposed to `markers`, which say what is true of it.
   * Rendered through `RowActions`, pinned over the row's trailing edge, so a
   * row reserves no width for them at rest.
   */
  actions?: React.ReactNode;
  onClick?: (commit: CommitRow) => void;
}) {
  const height = commitRowHeight(useControlSize());
  return (
    // A commit row IS a single line: the rail, sha, chips and timestamp are
    // rigid, and the subject is the one cell that gives. `Line` states that
    // contract once (region-line + the SingleLine context), so the `<Text>`
    // leaf below ellipsizes by ambient rule instead of a hand-applied class.
    <Line
      as="li"
      className={cn(
        "gap-sm border-b border-border/50 pl-sm pr-md",
        // A row that does something hovers to its surface's own hover step,
        // co-publishing it as `--scrim` so the pinned action cluster's mask
        // matches what is painted under it (the `css/row` contract).
        (onClick || actions) &&
          "hover:bg-hover-fill hover:[--scrim:var(--hover-fill)]",
        onClick && "cursor-pointer",
        actions && rowActionsAnchor,
      )}
      style={{ height }}
      onClick={onClick ? () => onClick(commit) : undefined}
    >
      <CommitRail isFirst={isFirst} isLast={isLast} color={color} />
      <Text
        as="span"
        variant="caption"
        className="font-mono text-muted-foreground"
        title={commit.sha}
      >
        {commit.shortSha}
      </Text>
      {/* The row's content, and the only cell that yields — every other leaf is
          rigid, so a row crowded with markers ellipsizes the subject rather
          than squeezing it to nothing. A typed role, not bare inherited text,
          so it steps down with the ambient density like its neighbours. */}
      <Fill as="span">
        <Text variant="body">{commit.subject}</Text>
      </Fill>
      {markers}
      {pushed && (
        <Badge variant="success" className={rigidClass()}>
          pushed
        </Badge>
      )}
      <Text
        as="span"
        variant="caption"
        className={cn(rigidClass(), "text-muted-foreground tabular-nums")}
        title={whenTitle(commit)}
      >
        {formatRelative(commit.authoredAt)}
      </Text>
      {actions && <RowActions>{actions}</RowActions>}
    </Line>
  );
}
