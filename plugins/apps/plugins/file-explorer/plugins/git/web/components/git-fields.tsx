import { useMemo, type ReactNode } from "react";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import type {
  ClientFieldReaders,
  ClientFieldsResolverProps,
} from "@plugins/network/plugins/live/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { absolutePath } from "@plugins/apps/plugins/file-explorer/plugins/browser/core";
import {
  useExplorerDir,
  useHomeDir,
} from "@plugins/apps/plugins/file-explorer/plugins/browser/web";
import { GIT_BADGE_OPTIONS, type gitFields, type GitBadge } from "../../core";
import { relativeTo } from "../../shared/status-index";
import { useGitView, type GitView } from "../internal/use-git";

type GitFieldsRecord = NonNullable<(typeof gitFields)["__fields"]>;
/** The row the fields are resolved for: the `fileEntry` kind's declared row. */
type EntryRow = NonNullable<(typeof gitFields)["__row"]>;

/** A folder holding changes below it — its own value, so it filters and groups too. */
const CONTAINS_CHANGES = "contains-changes";

/** The letter a badge draws (the label and tint are the field's options). */
const LETTERS: Record<GitBadge, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  untracked: "?",
  [CONTAINS_CHANGES]: "•",
};

/** The row's path relative to the checkout, when the view knows its checkout. */
function relOf(
  view: GitView,
  row: EntryRow,
  home: string | null,
): string | null {
  if (view.kind !== "ready" || home === null) return null;
  return relativeTo(view.checkout.rootAsGiven, absolutePath(row.path, home));
}

/** The row's badge: its own status (vs HEAD, else vs main), else a folder's rollup. */
function badgeOf(
  view: GitView,
  row: EntryRow,
  home: string | null,
): GitBadge | null {
  const rel = relOf(view, row, home);
  if (rel === null || view.kind !== "ready") return null;
  const entry = view.index.entry(rel);
  const own = entry?.vsHead ?? entry?.vsMain ?? null;
  if (own !== null) return own;
  if (row.kind === "dir" && view.index.hasChangedDescendant(rel))
    return CONTAINS_CHANGES;
  return null;
}

/** Whether the row changed vs main — or, for a folder, holds a path that did. */
function changedVsMain(
  view: GitView,
  row: EntryRow,
  home: string | null,
): boolean {
  const rel = relOf(view, row, home);
  if (rel === null || view.kind !== "ready") return false;
  if (view.index.entry(rel)?.vsMain != null) return true;
  return row.kind === "dir" && view.index.hasDescendantChangedVsMain(rel);
}

/** The badge cell of a row's git status (its label and tint are the field's option). */
export function GitBadgeCell({ badge }: { badge: GitBadge }): ReactNode {
  const { label, variant } = GIT_BADGE_OPTIONS[badge];
  if (badge === CONTAINS_CHANGES) {
    return (
      <span title={label}>
        <StatusDot colorClass="bg-warning" />
      </span>
    );
  }
  return (
    <Badge variant={variant} mono title={label}>
      {LETTERS[badge]}
    </Badge>
  );
}

/**
 * Resolves the tree's git client fields (`gitFields`) for the folder the
 * browser shows: `git` (the status badge) and `changed` ("Changed vs main").
 * While the status (or whether this is a checkout at all) is not known yet the
 * fields are pending — the badge cell says so rather than showing the file
 * clean. Outside a checkout the fields exist with no value (null — an empty
 * cell) rather than vanishing.
 */
export function GitFieldsResolver({
  render,
}: ClientFieldsResolverProps<EntryRow, GitFieldsRecord>): ReactNode {
  const dir = useExplorerDir();
  const homeDir = useHomeDir();
  const home = homeDir.kind === "ready" ? homeDir.home : null;
  const view = useGitView(dir);

  const values = useMemo<
    ResourceResult<ClientFieldReaders<EntryRow, GitFieldsRecord>>
  >(() => {
    if (view.kind === "loading") {
      return { status: "loading", refetch: () => Promise.resolve() };
    }
    if (view.kind === "failed") {
      return {
        status: "error",
        error: view.error,
        refetch: view.refetch,
      };
    }
    if (view.kind === "none") {
      return {
        status: "ready",
        data: { git: () => null, changed: () => null },
        refetch: () => Promise.resolve(),
      };
    }
    return {
      status: "ready",
      data: {
        git: (r) => badgeOf(view, r, home),
        changed: (r) => changedVsMain(view, r, home),
      },
      refetch: () => Promise.resolve(),
    };
  }, [view, home]);

  return <>{render(values)}</>;
}
