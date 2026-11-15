import { useState, type ReactElement } from "react";
import { ViewportOverlay } from "@plugins/primitives/plugins/css/plugins/viewport-overlay/web";
import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { LinkedHover } from "@plugins/primitives/plugins/data-view/core";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { useHoveredId } from "@plugins/primitives/plugins/data-view/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { SpendNode } from "../../core";
import { drills, money, partColor, pct, shareOf } from "../internal/format";
import "./spend.css";

const chevronIcon = symbol("chevron-right");

/** Where the pointer is over a segment, and which one. */
interface Tip {
  x: number;
  y: number;
  part: SpendNode;
  color: string;
}

/**
 * One part, as the tooltip over its segment names it: its name (with a
 * chevron when it opens), its share and amount, and its sub-line — plus the
 * billed API part of it, when any of it is.
 */
function SpendTip({
  tip,
  total,
  nameOf,
}: {
  tip: Tip;
  total: number;
  nameOf: (n: SpendNode) => string;
}): ReactElement {
  const { part } = tip;
  return (
    <ViewportOverlay className="pointer-events-none">
      <Placed
        x={{ start: tip.x, shift: "-50%" }}
        y={{ start: tip.y - 14, shift: "-100%" }}
        decorative
      >
        <Surface level="overlay" motion={false} className="sp-tip text-caption">
          <span className="st-h text-label text-foreground">
            <i style={{ background: tip.color }} />
            {nameOf(part)}
            {drills(part) ? (
              <Icon
                icon={chevronIcon}
                className="size-3 text-faint-foreground"
              />
            ) : null}
          </span>
          <span className="st-v tabular-nums text-muted-foreground">
            <b className="font-semibold text-foreground">
              {pct(shareOf(part.costUsd, total))}
            </b>
            {` · ${money(part.costUsd)}`}
          </span>
          {part.sub !== null ? (
            <span className="st-s text-faint-foreground">{part.sub}</span>
          ) : null}
          {part.billedUsd > 0 ? (
            <span className="st-s text-faint-foreground">
              {`${money(part.billedUsd)} billed API usage`}
            </span>
          ) : null}
        </Surface>
      </Placed>
    </ViewportOverlay>
  );
}

/**
 * A level's parts as one stacked bar, each segment as wide as its share.
 * Hovering a segment lights it (and its row, through `hover`), dims the rest
 * and names it in a tooltip; a segment that opens is picked by a click.
 */
export function SpendBar({
  node,
  hover,
  activationOf,
  thin = false,
  enter = false,
  nameOf,
}: {
  node: SpendNode;
  /** The hovered part, shared with whatever else draws the same parts. */
  hover: LinkedHover;
  /** What clicking a part does — `undefined` for one that opens nothing. */
  activationOf?: (part: SpendNode) => Activation | undefined;
  /** The glance's 6px bar, not the page's 12px. */
  thin?: boolean;
  /** Wipe in from the start as it mounts. */
  enter?: boolean;
  nameOf: (n: SpendNode) => string;
}): ReactElement {
  const hot = useHoveredId(hover);
  const [tip, setTip] = useState<Tip | null>(null);
  return (
    <div
      className={cn(
        "sp-bar",
        thin && "thin",
        enter && "enter",
        hot !== null && "has-hot",
      )}
      onMouseLeave={() => {
        if (hot !== null) hover.report(hot, false);
        setTip(null);
      }}
    >
      {node.children.map((part, i) => {
        const color = partColor(part, i);
        const activation = drills(part) ? activationOf?.(part) : undefined;
        return (
          // A segment is a hover target with a click shortcut: the same part
          // is reachable as a focusable row or legend entry beside the bar.
          <i
            key={part.id}
            className={cn(part.id === hot && "hot", activation && "pick")}
            // Grows by its share (the shares sum to 1, so the bar is filled
            // whatever the amounts' scale), from no basis.
            style={{
              flexGrow: shareOf(part.costUsd, node.costUsd),
              flexBasis: 0,
              background: color,
            }}
            onMouseMove={(e) => {
              if (hot !== part.id) hover.report(part.id, true);
              setTip({ x: e.clientX, y: e.clientY, part, color });
            }}
            {...activationProps(activation, { isolate: true })}
          />
        );
      })}
      {tip !== null ? (
        <SpendTip tip={tip} total={node.costUsd} nameOf={nameOf} />
      ) : null}
    </div>
  );
}
