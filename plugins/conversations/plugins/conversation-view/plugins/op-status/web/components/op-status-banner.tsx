import { createContext, useContext, useMemo, useState } from "react";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Spinner } from "@plugins/primitives/plugins/css/plugins/spinner/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import {
  Fill,
  fillClasses,
} from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  DataView,
  defineDataView,
  defineItemActions,
  type FieldDef,
  type ItemActionProps,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  HostedToolbar,
  HostedToolbarParts,
} from "@plugins/primitives/plugins/data-view/core";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import type { Conversation as ConversationRecord } from "@plugins/tasks/plugins/tasks-core/core";
import { useConversationTitleBySlug } from "@plugins/conversations/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { opDetailPane } from "@plugins/debug/plugins/profiling/plugins/ops/web";
import { WithTooltip } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import { WAIT_KINDS } from "@plugins/debug/plugins/profiling/plugins/op-log/core";
import type { OpRow } from "@plugins/debug/plugins/profiling/plugins/op-log/plugins/op-store/core";
import { OP_KINDS, type OpKind } from "@plugins/infra/plugins/worktree/core";
import { useSleepNowForFold } from "@plugins/infra/plugins/host/plugins/machine-sleep/web";
import type { SleepNow } from "@plugins/infra/plugins/host/plugins/machine-sleep/core";
import {
  formatElapsed,
  useNow,
} from "@plugins/primitives/plugins/relative-time/web";
import { navIcons, symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  buildSections,
  opsOfSlug,
  phaseOf,
  slugOf,
  stateLine,
  timesOf,
  type QueueRow,
  type RowPhase,
} from "../internal/op-lines";
import { useOpsInFlight } from "../internal/use-worktree-op";

const keyboardArrowUpIcon = symbol("keyboard-arrow-up");
const keyboardArrowDownIcon = symbol("keyboard-arrow-down");
const hourglassEmptyIcon = symbol("hourglass-empty");
const queuedIcon = symbol("radio-button-unchecked");

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const QUEUE_VIEW = defineDataView("conversations.op-status.queue");

/** A row of the expanded list, tagged with the section (op kind) it sits in. */
export interface QueueTableRow extends QueueRow {
  section: OpKind;
}

/** Per-consumer trailing-action slot for the expanded list's rows. */
export const OpQueueItemActions = defineItemActions<QueueTableRow>();

// Parked in a wait → hourglass (warning tone); working → spinner.
function StateIcon({
  waiting,
  className,
}: {
  waiting: boolean;
  className?: string;
}) {
  return waiting ? (
    <Icon
      icon={hourglassEmptyIcon}
      className={cn("size-3.5", rigidClass(), className)}
    />
  ) : (
    <Spinner className={cn("size-3.5", rigidClass())} />
  );
}

// Glyph per phase: working spins, held is the warning hourglass, queued is a
// quiet hollow dot — waiting its turn is the expected case, not an alarm.
function PhaseIcon({ phase }: { phase: RowPhase }) {
  if (phase === "working")
    return <Spinner className={cn("size-3.5", rigidClass())} />;
  return (
    <Icon
      icon={phase === "held" ? hourglassEmptyIcon : queuedIcon}
      className={cn(
        "size-3.5",
        phase === "held" ? "text-warning" : "text-muted-foreground/60",
        rigidClass(),
      )}
    />
  );
}

const PHASE_LABEL: Record<RowPhase, string> = {
  working: "Working",
  queued: "Queued",
  held: "Held",
};

const TIME_CELL = "font-mono tabular-nums";

/** A waited / worked / asleep cell: a faint dash under a second, dimmed when `dim`. */
function TimeCell({ ms, dim }: { ms: number; dim: boolean }) {
  if (ms < 1000)
    return <span className={cn(TIME_CELL, "text-muted-foreground/30")}>—</span>;
  return (
    <span
      className={cn(
        TIME_CELL,
        dim ? "text-muted-foreground/70" : "text-foreground",
      )}
    >
      {formatElapsed(ms)}
    </span>
  );
}

/** The machine's sleep clock and the presentational tick, for every clock cell. */
interface Clocks {
  now: number;
  sleepNow: SleepNow;
}

// "worked" never counts a nap; the asleep part shows only when there was one.
function RowTooltip({ item, clocks }: { item: QueueRow; clocks: Clocks }) {
  const times = timesOf(item.row, clocks.now, clocks.sleepNow);
  return (
    <Stack gap="2xs">
      <span>{stateLine(item.row, clocks.now, clocks.sleepNow)}</span>
      <span className="text-muted-foreground">
        waited {formatElapsed(times.waitingMs)} · worked{" "}
        {formatElapsed(times.workingMs)}
        {times.asleepMs > 0 && ` · asleep ${formatElapsed(times.asleepMs)}`}
      </span>
    </Stack>
  );
}

/** The title cell: the conversation's title (else its slug), tagged on the self row. */
function TitleCell({
  item,
  title,
  clocks,
}: {
  item: QueueRow;
  title: string | undefined;
  clocks: Clocks;
}) {
  return (
    <WithTooltip
      content={<RowTooltip item={item} clocks={clocks} />}
      side="left"
    >
      <span
        className={cn(
          "block truncate",
          item.isSelf ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {title ?? <span className="font-mono">{item.slug}</span>}
        {item.isSelf && (
          // eslint-disable-next-line spacing/no-adhoc-spacing -- inline left offset on a trailing label inside a truncating cell; not a sibling gap the parent can own
          <span className="ml-1.5 font-normal text-primary-text">
            this conversation
          </span>
        )}
      </span>
    </WithTooltip>
  );
}

/** Open another row's conversation; absent for the current one and for an op no conversation launched. */
export function OpenConversationAction({
  row,
}: ItemActionProps<QueueTableRow>) {
  const openPane = useOpenPane();
  const convId = row.row.conversationId;
  if (convId === null || row.isSelf) return null;
  return (
    <IconButton
      icon={navIcons.sidePane}
      label="Open conversation"
      {...activationProps(
        openPane.to(conversationPane, { convId }, { mode: "push" }),
        { isolate: true },
      )}
    />
  );
}

/**
 * What the card's header shows and how it folds — the half of the banner that
 * is NOT the DataView's. Travels by context because the frame is declared at
 * module scope (a fresh identity each render would remount the card) and
 * renders inside the DataView, below where the banner holds this state.
 */
interface BannerChrome {
  op: OpRow;
  clocks: Clocks;
  others: number;
  expanded: boolean;
  toggle: () => void;
}

const BannerChromeContext = createContext<BannerChrome | null>(null);

function useBannerChrome(): BannerChrome {
  const chrome = useContext(BannerChromeContext);
  if (chrome === null)
    throw new Error("OpStatusCard renders only inside OpStatusBanner");
  return chrome;
}

/**
 * The banner's card — the DataView's hosted frame. The header line folds the
 * list; while expanded it also carries the list's one options trigger
 * (search, filter, sort), so the controls cost no line of their own. The rows
 * come back as `body`, drawn only while expanded.
 */
function OpStatusCard({ options, body }: HostedToolbarParts) {
  const { op, clocks, others, expanded, toggle } = useBannerChrome();
  const waiting = op.openWait !== null;
  const times = timesOf(op, clocks.now, clocks.sleepNow);
  return (
    <Clip
      className={`rounded-md border ${
        waiting
          ? "border-warning/40 bg-warning/10 text-warning"
          : "border-border bg-muted/30 text-foreground"
      }`}
    >
      <Line className="hover:bg-foreground/[0.03]">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          className={cn(fillClasses("x"), "text-left")}
        >
          <Stack
            direction="row"
            gap="sm"
            align="center"
            className="px-md py-sm"
          >
            <StateIcon waiting={waiting} />
            <Fill as="span" className="truncate">
              {stateLine(op, clocks.now, clocks.sleepNow)}
            </Fill>
            {others > 0 && (
              <span className={cn("text-muted-foreground", rigidClass())}>
                +{others} other{others === 1 ? "" : "s"}
              </span>
            )}
            <span
              className={cn(
                "font-mono tabular-nums text-muted-foreground",
                rigidClass(),
              )}
            >
              {formatElapsed(times.elapsedMs)}
            </span>
            <Icon
              icon={expanded ? keyboardArrowUpIcon : keyboardArrowDownIcon}
              className={cn("size-4 text-muted-foreground", rigidClass())}
            />
          </Stack>
        </button>
        {expanded && options !== null && (
          <span className={cn("pr-sm text-foreground", rigidClass())}>
            {options}
          </span>
        )}
      </Line>
      {expanded && (
        // The list sits on the surface's own background (`bg-chrome-mask`),
        // not a translucent wash of the card's tone: the table's group headers
        // pin with `bg-chrome-mask`, so any other fill here would paint them as
        // bands of a different colour.
        <div className="border-t border-border/60 bg-chrome-mask py-2xs text-foreground">
          {body}
        </div>
      )}
    </Clip>
  );
}

const CARD_TOOLBAR: HostedToolbar = { kind: "hosted", frame: OpStatusCard };

/**
 * The expanded list's schema: one table row per in-flight op, grouped by
 * section (op kind). Only the two clocks are labelled — once, on the first
 * section header (`columnHeader: "first-group"`); the glyph, position, title
 * and held columns read from their cells. The asleep clock is hidden by
 * default (a nap is rare and the row tooltip already names it) and revealed
 * from the list's Properties.
 */
function queueFields(
  sectionOptions: { value: OpKind; label: string }[],
  titleBySlug: Readonly<Record<string, string>>,
  clocks: Clocks,
): FieldDef<QueueTableRow>[] {
  const times = (r: QueueTableRow) =>
    timesOf(r.row, clocks.now, clocks.sleepNow);
  return [
    {
      id: "section",
      label: "Section",
      type: "enum",
      value: (r) => r.section,
      options: sectionOptions,
      groupable: true,
      visible: false,
    },
    {
      id: "phase",
      label: "Phase",
      header: false,
      type: "enum",
      value: (r) => phaseOf(r.row),
      options: (["working", "held", "queued"] as const).map((value) => ({
        value,
        label: PHASE_LABEL[value],
      })),
      filterable: true,
      // `auto`, not a fixed size: the leading track of a subgrid row also
      // carries the row's inline padding (`rail-follow`), which a fixed track
      // would subtract from the glyph — an auto track grows to fit both.
      width: "auto",
      cell: (r) => <PhaseIcon phase={phaseOf(r.row)} />,
    },
    {
      id: "pos",
      label: "Queue position",
      header: false,
      type: "number",
      value: (r) => r.queuePos,
      width: "1rem",
      align: "end",
      cell: (r) => (
        <span className="font-mono tabular-nums text-muted-foreground">
          {r.queuePos}
        </span>
      ),
    },
    {
      id: "title",
      label: "Conversation",
      header: false,
      type: "text",
      primary: true,
      value: (r) => titleBySlug[r.slug] ?? r.slug,
      width: "minmax(0,1fr)",
      cell: (r) => (
        <TitleCell item={r} title={titleBySlug[r.slug]} clocks={clocks} />
      ),
    },
    {
      id: "held",
      label: "Held",
      header: false,
      type: "text",
      value: (r) =>
        phaseOf(r.row) === "held" && r.row.openWait
          ? WAIT_KINDS[r.row.openWait.kind].sentence(null)
          : null,
      width: "auto",
      cell: (r) =>
        phaseOf(r.row) === "held" && r.row.openWait ? (
          <span className="truncate text-warning">
            {WAIT_KINDS[r.row.openWait.kind].sentence(null)}
          </span>
        ) : null,
    },
    {
      id: "waited",
      label: "Waited",
      header: "waited",
      type: "number",
      value: (r) => times(r).waitingMs,
      // Content-sized: one grid, so every section's clock lines up with the
      // widest cell or the label (+ its sort icon) on the first header.
      width: "auto",
      align: "end",
      cell: (r) => <TimeCell ms={times(r).waitingMs} dim />,
    },
    {
      id: "worked",
      label: "Worked",
      header: "worked",
      type: "number",
      value: (r) => times(r).workingMs,
      // Content-sized: one grid, so every section's clock lines up with the
      // widest cell or the label (+ its sort icon) on the first header.
      width: "auto",
      align: "end",
      cell: (r) => (
        <TimeCell ms={times(r).workingMs} dim={phaseOf(r.row) === "queued"} />
      ),
    },
    {
      id: "asleep",
      label: "Asleep",
      header: "asleep",
      type: "number",
      value: (r) => times(r).asleepMs,
      // Hidden until a user turns it on from the list's Properties.
      visible: false,
      width: "auto",
      align: "end",
      cell: (r) => <TimeCell ms={times(r).asleepMs} dim />,
    },
  ];
}

/**
 * The worktree's in-flight op above the prompt input, off the one host-wide
 * `opsInFlight` read. The state line is the reducer's: the wait the op is
 * parked in (with its reason, requeue cycle and own clock) or the work it is
 * doing; the right side is the total elapsed. The warning tone means "parked
 * in a wait" — before the grant or after it. Expanded, it lists every
 * in-flight op on the host as a grouped compact table (a DataView).
 */
export function OpStatusBanner({
  conversation,
}: {
  conversation: ConversationRecord;
}) {
  const result = useOpsInFlight();
  const titleBySlug = useConversationTitleBySlug();
  const openPane = useOpenPane();
  // A presentational 1 s ticker for the clocks; the op state itself is pushed,
  // and so is the machine's sleep clock (it changes only on a wake).
  const now = useNow(1000);
  const sleepNow = useSleepNowForFold();
  const clocks = useMemo<Clocks>(() => ({ now, sleepNow }), [now, sleepNow]);
  const [expanded, setExpanded] = useState(false);

  const selfSlug = slugOf(conversation.worktreePath);
  const data = result.status === "ready" ? result.data : null;
  const op = data ? opsOfSlug(data, selfSlug)[0] : undefined;

  const chrome = useMemo<BannerChrome | null>(
    () =>
      op && data
        ? {
            op,
            clocks,
            others: data.length - 1,
            expanded,
            toggle: () => setExpanded((v) => !v),
          }
        : null,
    [op, data, clocks, expanded],
  );

  // buildSections is the order authority (self section first, global push
  // positions, working → held → queued); flattened in that order, with the
  // section's options listed in it too, so the enum groups follow it.
  const { rows, sectionOptions } = useMemo(() => {
    const sections = data ? buildSections(data, selfSlug) : [];
    return {
      rows: sections.flatMap((s) =>
        s.rows.map((r): QueueTableRow => ({ ...r, section: s.kind })),
      ),
      sectionOptions: sections.map((s) => ({
        value: s.kind,
        label: s.kind === "push" ? "Push queue" : OP_KINDS[s.kind].label,
      })),
    };
  }, [data, selfSlug]);

  const fields = useMemo(
    () => queueFields(sectionOptions, titleBySlug, clocks),
    [sectionOptions, titleBySlug, clocks],
  );

  if (result.status === "loading") return null;
  if (result.status === "error")
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the in-flight ops"
        error={result.error}
        refetch={result.refetch}
      />
    );
  if (!op || !chrome) return null;

  return (
    // The caption wrapper is authored HERE, not in the frame, so the banner's
    // own owner stamp (`OpStatusBanner@…`) sits on the element holding the
    // whole card — what the e2e and the element picker name it by.
    <Text as="div" variant="caption">
      <BannerChromeContext.Provider value={chrome}>
        <DataView<QueueTableRow>
          rows={rows}
          fields={fields}
          rowKey={(r) => r.row.opId}
          views={["table"]}
          storageKey={QUEUE_VIEW}
          readiness={result}
          density="compact"
          groupHeaders="quiet"
          toolbar={CARD_TOOLBAR}
          selectedRowId={op.opId}
          searchPlaceholder="Search ops"
          searchAccessor={(r) => `${titleBySlug[r.slug] ?? ""} ${r.slug}`}
          itemActions={OpQueueItemActions}
          // Every op has a detail pane — in flight included — with its wait
          // timeline and step breakdown.
          rowActivation={(r) =>
            openPane.to(opDetailPane, { opId: r.row.opId }, { mode: "push" })
          }
          viewOptions={{ table: { columnHeader: "first-group" } }}
          emptyState={
            <Text tone="muted">No op matches what you searched for.</Text>
          }
        />
      </BannerChromeContext.Provider>
    </Text>
  );
}
