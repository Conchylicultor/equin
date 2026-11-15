import type { ReactElement } from "react";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import {
  activationProps,
  gestureOf,
  linkProps,
} from "@plugins/primitives/plugins/link-gesture/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  useHoveredId,
  useLinkedHover,
} from "@plugins/primitives/plugins/data-view/web";
import type { LinkedHover } from "@plugins/primitives/plugins/data-view/core";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { SPEND_ROOT_ID, type SpendNode } from "../../core";
import { money, partColor, pathParam, pct, shareOf } from "../internal/format";
import { useSpend } from "../internal/read";
import { windowWords } from "../internal/windows";
import { supervisorsSpendPane } from "../panes";
import { SpendBar } from "./spend-bar";
import "./spend.css";

const categoryName = (n: SpendNode): string => n.name;

/** One legend entry: the category's colour, short name and share. */
function LegendEntry({
  part,
  index,
  total,
  hover,
  hotId,
  open,
}: {
  part: SpendNode;
  index: number;
  total: number;
  hover: LinkedHover;
  /** The hovered part (a segment or a legend entry), if any. */
  hotId: string | null;
  open: LinkTarget;
}): ReactElement {
  const hot = hotId === part.id;
  const anyHot = hotId !== null;
  return (
    <span
      className={cn(
        hot ? "text-foreground" : "text-muted-foreground",
        anyHot && !hot && "dim",
      )}
      onMouseEnter={() => hover.report(part.id, true)}
      onMouseLeave={() => hover.report(part.id, false)}
      {...activationProps(open, { isolate: true })}
    >
      <i style={{ background: partColor(part, index) }} />
      {part.short ?? part.name}
      <b className="tabular-nums text-strong-foreground">
        {pct(shareOf(part.costUsd, total))}
      </b>
    </span>
  );
}

/**
 * "Spent this week" at a glance, atop the Supervisors list: the total, the
 * categories as one thin bar and a two-column legend. The card opens the
 * breakdown; a segment or a legend entry opens its category. A skeleton until
 * the spend is known — never $0.
 */
export function SpendGlance(): ReactElement {
  const read = useSpend();
  const openPane = useOpenPane();
  const hover = useLinkedHover();
  const hotId = useHoveredId(hover);
  const selected = supervisorsSpendPane.useRouteEntry() !== null;
  const to = (path: readonly string[]) =>
    openPane.to(
      supervisorsSpendPane,
      { path: pathParam(path) },
      { mode: "push" },
    );
  const root = to([SPEND_ROOT_ID]);

  if (read.status === "unavailable") return <></>;
  if (read.status === "error")
    return (
      <ResourceErrorInline
        error={read.error}
        refetch={read.refetch}
        variant="block"
        subject="this week's spend"
      />
    );
  const data = read.status === "ready" ? read.data : null;
  const tree = data?.tree ?? null;
  return (
    <div
      role="link"
      tabIndex={0}
      className={cn("sp-glance rounded-md", selected && "on")}
      title={
        data === null ? undefined : data.windows.map(windowWords).join(" · ")
      }
      {...linkProps(root)}
      onKeyDown={(e) => {
        if (e.key === "Enter") root.open(gestureOf(e));
      }}
    >
      <span className="sg-top text-caption text-muted-foreground">
        <span>Spent this week</span>
        {tree === null ? (
          <Loading variant="block" className="h-4 w-12" />
        ) : (
          <b className="text-label font-semibold tabular-nums text-foreground">
            {money(tree.costUsd)}
          </b>
        )}
      </span>
      {tree === null ? (
        <Loading variant="block" className="sp-skel w-full" />
      ) : (
        <SpendBar
          node={tree}
          hover={hover}
          thin
          enter
          nameOf={categoryName}
          activationOf={(part) => to([SPEND_ROOT_ID, part.id])}
        />
      )}
      {tree === null ? null : (
        <span className="sg-legend text-caption">
          {tree.children.map((part, i) => (
            <LegendEntry
              key={part.id}
              part={part}
              index={i}
              total={tree.costUsd}
              hover={hover}
              hotId={hotId}
              open={to([SPEND_ROOT_ID, part.id])}
            />
          ))}
        </span>
      )}
    </div>
  );
}
