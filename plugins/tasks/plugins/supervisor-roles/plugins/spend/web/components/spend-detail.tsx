import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  combineResources,
  ResourceErrorInline,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { automationsCatalog } from "@plugins/tasks/plugins/automations/core";
import {
  DataView,
  defineDataView,
  defineItemActions,
  useLinkedHover,
  type FieldDef,
  type ItemActionProps,
} from "@plugins/primitives/plugins/data-view/web";
import {
  createLinkedHover,
  type HostedToolbar,
  type HostedToolbarParts,
} from "@plugins/primitives/plugins/data-view/core";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import {
  Breadcrumb,
  BreadcrumbPlaces,
  type BreadcrumbSegment,
} from "@plugins/primitives/plugins/breadcrumb/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { navIcons, symbol } from "@plugins/ui/plugins/icons/core";
import {
  PLAIN_GESTURE,
  type LinkTarget,
} from "@plugins/primitives/plugins/link-gesture/core";
import { useSurfaceShortcuts } from "@plugins/primitives/plugins/shortcuts/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { SpendNode } from "../../core";
import {
  drills,
  money,
  nodesAlong,
  partColor,
  pathOf,
  pct,
  segmentOf,
  shareOf,
} from "../internal/format";
import { useSpend, type SpendRead } from "../internal/read";
import { windowWords } from "../internal/windows";
import { CountTo } from "./count-to";
import { SpendBar } from "./spend-bar";
import "./spend.css";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const SPEND_VIEW = defineDataView("tasks.supervisor-roles.spend");

const chevronIcon = symbol("chevron-right");

/** The ghost bar's hover: nobody hovers a bar that is fading out. */
const GHOST_HOVER = createLinkedHover();

/** The bar's zoom between levels, and how long the rows take to swap. */
const ZOOM: KeyframeAnimationOptions = {
  duration: 520,
  easing: "cubic-bezier(.22,.8,.24,1)",
};

/** One row of a level: the part, and its place among its siblings. */
export interface SpendRow {
  part: SpendNode;
  index: number;
  /** The level's total, for the share. */
  total: number;
  /** The part's name, as drawn (an automation by its label). */
  name: string;
}

/** A conversation leaf's one verb: open it in a pane beside this one. */
const SpendRowActions = defineItemActions<SpendRow>();

function OpenConversationAction({
  row,
}: ItemActionProps<SpendRow>): ReactElement | null {
  const openPane = useOpenPane();
  const convId = row.part.conversationId;
  if (convId === null || drills(row.part)) return null;
  return (
    <IconButton
      icon={navIcons.sidePane}
      label="Open in a new pane"
      {...activationProps(
        openPane.to(conversationPane, { convId }, { mode: "push" }),
        { isolate: true },
      )}
    />
  );
}

export const spendRowActions = [
  SpendRowActions({ id: "open", component: OpenConversationAction }),
];
export { SpendRowActions };

/**
 * The rows draw no toolbar band: a level is six rows at most, which no
 * search, filter or view switch helps with — the rows are the level.
 */
function RowsFrame({ body }: HostedToolbarParts): ReactNode {
  return body;
}
const ROWS_TOOLBAR: HostedToolbar = { kind: "hosted", frame: RowsFrame };

const FIELDS: FieldDef<SpendRow>[] = [
  {
    id: "name",
    label: "Spent on",
    type: "text",
    primary: true,
    value: (r) => r.name,
  },
  {
    id: "cost",
    label: "Spent",
    type: "number",
    value: (r) => r.part.costUsd,
  },
  {
    // The level's own order (biggest first, the rest last; the categories in
    // their fixed order) — the view sorts by it.
    id: "position",
    label: "Position",
    type: "number",
    value: (r) => r.index,
    visible: false,
  },
];

/** A row's body: colour, name and sub-line, share bar, %, amount, chevron. */
function SpendRowBody({ row }: { row: SpendRow }): ReactElement {
  const { part, index, total } = row;
  const color = partColor(part, index);
  const share = shareOf(part.costUsd, total);
  return (
    <span className="sp-row">
      <i className="sp-sw" style={{ background: color }} />
      <span className="sp-nm">
        <span className="t" title={row.name}>
          <span
            className={cn(
              "text-label font-normal",
              part.kind === "rest"
                ? "text-muted-foreground"
                : "text-foreground",
            )}
          >
            {row.name}
          </span>
          {part.live ? <i className="ldot bg-success" title="Live" /> : null}
        </span>
        {subOf(part) !== null ? (
          <span className="sp-sub text-caption text-faint-foreground">
            {subOf(part)}
          </span>
        ) : null}
      </span>
      <span className="sp-share bg-foreground/10">
        <i style={{ width: `${share * 100}%`, background: color }} />
      </span>
      <span className="sp-pct text-caption tabular-nums text-foreground">
        {pct(share)}
      </span>
      <span className="sp-v text-caption tabular-nums text-faint-foreground">
        {money(part.costUsd)}
      </span>
      <span className="sp-go text-faint-foreground">
        {drills(part) ? <Icon icon={chevronIcon} className="size-3.5" /> : null}
      </span>
    </span>
  );
}

/** A row's sub-line, with the billed API part of it when there is one. */
function subOf(part: SpendNode): string | null {
  const billed =
    part.billedUsd > 0 ? `${money(part.billedUsd)} billed API usage` : null;
  const line = [part.sub, billed].filter((s): s is string => s !== null);
  return line.length === 0 ? null : line.join(" · ");
}

/** The zoom between two levels, keyed so each move runs once. */
interface Move {
  id: number;
  prev: SpendNode;
  dir: "in" | "out";
  x: number;
  w: number;
}

/**
 * The breakdown, one level at a time. The title is the path (ancestors faint
 * and clickable); the total counts to the level's; the bar zooms into (or
 * back out of) the picked segment; the rows cross-fade. Esc goes up a level.
 */
export function SpendDetail({
  path: pathParamValue,
  linkTo,
}: {
  /** The drill path, as its route param. */
  path: string;
  /** Where another level opens (a drill path, the root's id first). */
  linkTo: (path: readonly string[]) => LinkTarget;
}): ReactElement {
  const read = useSpend();
  const catalog = useLive(automationsCatalog);
  const combined = combineResources({ spend: read, catalog });
  if (combined.status === "loading")
    return <Loading variant="rows" count={5} />;
  if (combined.status === "unavailable")
    return <Placeholder>{combined.message}</Placeholder>;
  if (combined.status === "error")
    return (
      <ResourceErrorInline
        error={combined.error}
        refetch={combined.refetch}
        variant="block"
        subject="this week's spend"
      />
    );
  const labels = new Map(combined.data.catalog.map((a) => [a.id, a.label]));
  const nameOf = (n: SpendNode): string =>
    n.kind === "automation" ? (labels.get(n.id) ?? n.name) : n.name;
  return (
    <SpendLevels
      requested={pathOf(pathParamValue)}
      read={combined.data.spend}
      nameOf={nameOf}
      linkTo={linkTo}
    />
  );
}

function SpendLevels({
  requested,
  read,
  nameOf,
  linkTo,
}: {
  requested: string[];
  read: SpendRead;
  nameOf: (n: SpendNode) => string;
  linkTo: (path: readonly string[]) => LinkTarget;
}): ReactElement {
  const nodes = nodesAlong(read.tree, requested);
  const path = nodes.map((n) => n.id);
  const key = path.join("/");
  const node = nodes[nodes.length - 1] ?? read.tree;
  const hover = useLinkedHover();

  // ---- a level change: which way, where in the bar, what to animate ----
  const [shown, setShown] = useState<{ key: string; nodes: SpendNode[] }>({
    key,
    nodes,
  });
  const [move, setMove] = useState<Move | null>(null);
  if (shown.key !== key) {
    const before = shown.nodes.map((n) => n.id);
    const down =
      path.length > before.length && before.every((id, i) => path[i] === id);
    const up =
      before.length > path.length && path.every((id, i) => before[i] === id);
    const prevNode = shown.nodes[shown.nodes.length - 1];
    if ((down || up) && prevNode) {
      const parent = down ? prevNode : node;
      const childId = down ? path[before.length] : before[path.length];
      const { x, w } =
        childId === undefined ? { x: 0, w: 1 } : segmentOf(parent, childId);
      setMove({
        id: (move?.id ?? 0) + 1,
        prev: prevNode,
        dir: down ? "in" : "out",
        x,
        w,
      });
    } else {
      setMove(null);
    }
    setShown({ key, nodes });
  }

  // A new level: nothing of it is hovered yet (the pointer's part left).
  useEffect(() => {
    const hot = hover.get();
    if (hot !== null) hover.report(hot, false);
  }, [key, hover]);

  // ---- Esc goes up a level (while this surface is focused; any other
  // binding of Esc — a menu, a dialog, a field — wins) ----
  const upRef = useLatestRef(
    path.length < 2 ? null : linkTo(path.slice(0, -1)),
  );
  const shortcuts = useMemo(
    () => [
      {
        id: "supervisors-spend.up",
        keys: "Escape",
        label: "Up a level",
        precedence: -1,
        when: () => upRef.current !== null,
        handler: () => upRef.current?.open(PLAIN_GESTURE),
      },
    ],
    [upRef],
  );
  useSurfaceShortcuts(shortcuts);

  // ---- the motion ----
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  /** The rows as last drawn, and where — what fades out over the new ones. */
  const lastRows = useRef<{
    clone: Node;
    top: number;
    left: number;
    width: number;
  } | null>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const rows = rowsRef.current;
    if (!move || !root || !rows) return;
    const { x, w, dir } = move;
    const narrow = `translateX(${x * 100}%) scaleX(${w})`;
    const wide = `scaleX(${1 / Math.max(w, 0.001)}) translateX(${-x * 100}%)`;
    // 1. The bar zooms; the old one fades out as a ghost.
    const bar = barRef.current?.animate(
      dir === "in"
        ? [{ transform: narrow }, { transform: "none" }]
        : [
            { transform: wide, opacity: 0 },
            { opacity: 1, offset: 0.35 },
            { transform: "none", opacity: 1 },
          ],
      ZOOM,
    );
    ghostRef.current?.animate(
      [
        { transform: "none", opacity: 1 },
        { opacity: 0, offset: 0.45 },
        { transform: dir === "in" ? wide : narrow, opacity: 0 },
      ],
      { ...ZOOM, fill: "forwards" },
    );
    const id = move.id;
    if (bar) bar.onfinish = () => setMove((m) => (m?.id === id ? null : m));
    // 2. Everything else stays where it is and cross-fades: the old rows
    // fade out on top of the new ones, which fade in under them.
    const last = lastRows.current;
    if (last) {
      const clone = last.clone as HTMLElement;
      Object.assign(clone.style, {
        position: "absolute",
        margin: "0",
        pointerEvents: "none",
        left: `${last.left}px`,
        top: `${last.top}px`,
        width: `${last.width}px`,
      });
      root.appendChild(clone);
      void clone
        .animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 110,
          easing: "ease-in",
          fill: "forwards",
        })
        .finished.then(() => clone.remove());
    }
    rows.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 200,
      delay: 100,
      easing: "ease-out",
      fill: "backwards",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per move: its id is the move
  }, [move?.id]);
  // After every draw (and after the move above read the previous one): keep
  // a frozen copy of the rows for the next move.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const rows = rowsRef.current;
    if (!root || !rows) return;
    const r = rows.getBoundingClientRect();
    const o = root.getBoundingClientRect();
    lastRows.current = {
      clone: rows.cloneNode(true),
      top: r.top - o.top,
      left: r.left - o.left,
      width: r.width,
    };
  });

  const rows: SpendRow[] = node.children.map((part, index) => ({
    part,
    index,
    total: node.costUsd,
    name: nameOf(part),
  }));
  const segments = segmentsOf(nodes, nameOf, linkTo);

  return (
    <div ref={rootRef} className="sp-page rail-lg">
      <div className="sp-title">
        {/* The title is the path: the shared trail, drilled one level at a
            time, so its crumbs wipe in and out as the levels change. */}
        <div className="sp-path text-title text-foreground">
          <Breadcrumb segments={segments} motion="wipe" leafWeight="semibold" />
        </div>
        <span title={read.windows.map(windowWords).join("\n")}>
          <CountTo
            value={node.costUsd}
            className="sp-total text-title text-foreground"
          />
        </span>
      </div>
      {read.countedSince !== null ? (
        <span className="text-caption text-faint-foreground">
          {`Counted since ${new Date(read.countedSince).toLocaleString(
            "en-US",
            {
              weekday: "short",
              hour: "2-digit",
              minute: "2-digit",
              hourCycle: "h23",
            },
          )} — spend before it is not attributed`}
        </span>
      ) : null}
      <div className="sp-stage">
        <div ref={barRef} className="sp-zoom">
          <SpendBar
            node={node}
            hover={hover}
            nameOf={nameOf}
            activationOf={(part) => linkTo([...path, part.id])}
          />
        </div>
        {move ? (
          <div ref={ghostRef} className="sp-zoom ghost" key={`g${move.id}`}>
            <SpendBar node={move.prev} hover={GHOST_HOVER} nameOf={nameOf} />
          </div>
        ) : null}
      </div>
      <div ref={rowsRef} className="sp-rows">
        <DataView<SpendRow>
          key={key}
          rows={rows}
          fields={FIELDS}
          rowKey={(r) => r.part.id}
          views={["list"]}
          storageKey={SPEND_VIEW}
          toolbar={ROWS_TOOLBAR}
          rowHover={hover}
          rowActivation={(r) =>
            drills(r.part) ? linkTo([...path, r.part.id]) : undefined
          }
          itemActions={SpendRowActions}
          viewOptions={{
            list: { renderRow: (r: SpendRow) => <SpendRowBody row={r} /> },
          }}
          emptyState={<>Nothing spent this week.</>}
        />
      </div>
    </div>
  );
}

/**
 * One level of the breakdown as a crumb's menu: the parts of `parent` that
 * open a level of their own (a conversation is a row, not a level), the one
 * on the path first and marked, each with its own levels as a submenu. The
 * whole tree is in hand, so a level costs no read.
 */
function SpendLevelPlaces({
  parent,
  parentPath,
  trail,
  nameOf,
  linkTo,
}: {
  parent: SpendNode;
  parentPath: readonly string[];
  trail: ReadonlySet<string>;
  nameOf: (n: SpendNode) => string;
  linkTo: (path: readonly string[]) => LinkTarget;
}): ReactElement {
  return (
    <BreadcrumbPlaces
      places={parent.children.filter(drills).map((part) => {
        const path = [...parentPath, part.id];
        return {
          key: part.id,
          label: nameOf(part),
          activation: linkTo(path),
          onTrail: trail.has(path.join("/")),
          inside: part.children.some(drills) ? (
            <SpendLevelPlaces
              parent={part}
              parentPath={path}
              trail={trail}
              nameOf={nameOf}
              linkTo={linkTo}
            />
          ) : undefined,
        };
      })}
    />
  );
}

/**
 * The path's crumbs: "Spent this week", then each level's name — each a link
 * to its level, and each but the first listing the levels beside it.
 */
function segmentsOf(
  nodes: readonly SpendNode[],
  nameOf: (n: SpendNode) => string,
  linkTo: (path: readonly string[]) => LinkTarget,
): BreadcrumbSegment[] {
  const paths = nodes.map((_, i) => nodes.slice(0, i + 1).map((x) => x.id));
  const trail = new Set(paths.map((p) => p.join("/")));
  return nodes.map((n, i) => {
    const parent = nodes[i - 1];
    return {
      key: paths[i]!.join("/"),
      label: nameOf(n),
      activation: linkTo(paths[i]!),
      // The root ("Spent this week") is the only level with no parent.
      siblings:
        parent === undefined ? null : (
          <SpendLevelPlaces
            parent={parent}
            parentPath={paths[i - 1]!}
            trail={trail}
            nameOf={nameOf}
            linkTo={linkTo}
          />
        ),
    };
  });
}
