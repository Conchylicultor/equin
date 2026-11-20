import { Icon } from "@plugins/ui/plugins/icons/web";
import type { ReactNode } from "react";
import type {
  Contribution,
  SealContributions,
} from "@plugins/framework/plugins/web-sdk/core";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import { PluginErrorBoundary } from "@plugins/primitives/plugins/error-boundary/web";
import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  useCollapsibleContext,
} from "@plugins/primitives/plugins/collapsible/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { RowActions } from "@plugins/primitives/plugins/row-actions/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import {
  isPulsing,
  isTransitioning,
  levelOf,
  type HealthReportRow,
  type ReportedStatus,
} from "../../core";
import { HealthReport } from "../slots";
import { SUMMARY_CLASS } from "../internal/tone";
import { HealthDot } from "./health-dot";

type SealedRow = SealContributions<HealthReportRow>;
type SealedStatusRow = Extract<SealedRow, { kind: "status" }>;
type SealedInfoRow = Extract<SealedRow, { kind: "info" }>;
type SealedSetRow = Extract<SealedRow, { kind: "set" }>;

/**
 * One status line of the report: a status row, one item of a row set (its
 * own line, with its own expand state — the set's parts drawn for its
 * `rowKey`), or a row set that has no items to show yet (pending or failed:
 * one line under the set's title, without the per-item parts).
 */
export type StatusLine =
  | { kind: "status"; id: string; row: SealedStatusRow }
  | {
      kind: "set-item";
      id: string;
      row: SealedSetRow;
      rowKey: string;
      title: string;
    }
  | { kind: "set-placeholder"; id: string; row: SealedSetRow };

/** A line's contributed parts, already bound to the item they are drawn for. */
interface LineParts {
  glance?: (expanded: boolean) => ReactNode;
  actions?: ReactNode;
  remedy?: ReactNode;
  /** The expandable detail; its presence is the chevron. */
  detail?: () => ReactNode;
}

function partsOf(line: StatusLine): LineParts {
  switch (line.kind) {
    case "status": {
      const { row } = line;
      const { glance: Glance, actions: Actions, remedy: Remedy } = row;
      return {
        glance: Glance && ((expanded) => <Glance expanded={expanded} />),
        actions: Actions && <Actions />,
        remedy: Remedy && <Remedy />,
        detail:
          row.component &&
          (() =>
            renderIsolated(HealthReport.Row, row as unknown as Contribution)),
      };
    }
    case "set-item": {
      const { row, rowKey } = line;
      const { glance: Glance, actions: Actions, remedy: Remedy } = row;
      return {
        glance:
          Glance &&
          ((expanded) => <Glance expanded={expanded} rowKey={rowKey} />),
        actions: Actions && <Actions rowKey={rowKey} />,
        remedy: Remedy && <Remedy rowKey={rowKey} />,
        detail:
          row.component &&
          (() =>
            renderIsolated(HealthReport.Row, row as unknown as Contribution, {
              rowKey,
            })),
      };
    }
    case "set-placeholder":
      // No item to draw the parts for.
      return {};
  }
}

/**
 * A line that shows nothing at rest beyond its summary — what `foldQuietRows`
 * may fold. A `glance` or `actions` are drawn on the line itself, so they keep
 * it out. A `component` does not count: it is a detail behind the line's own
 * chevron, still one click away inside the card. Nor does a `remedy`: it is
 * drawn only while the row is not ok, and a folded row is ok. A set's lines
 * read the set's declared shape, so a placeholder sits where its items will.
 */
export function isPlainLine(line: StatusLine): boolean {
  const { row } = line;
  return row.glance === undefined && row.actions === undefined;
}

/**
 * Contains a crash in a contributor's `glance` / `actions` to that one piece of
 * the row. (The row as a whole sits in its own boundary in the panel; the
 * sealed `component` gets one from `renderIsolated`.)
 */
function ContributedPart({
  row,
  children,
}: {
  row: SealedRow;
  children: ReactNode;
}) {
  return (
    <PluginErrorBoundary
      slot={HealthReport.Row.id}
      label={row._pluginId ?? row.id}
    >
      {children}
    </PluginErrorBoundary>
  );
}

/** The row's trailing controls, boundaried — or nothing when it declares none. */
function contributedActions(row: SealedRow, actions: ReactNode): ReactNode {
  if (actions === undefined) return null;
  return <ContributedPart row={row}>{actions}</ContributedPart>;
}

/**
 * `actions`, followed by the line's `remedy` while it needs a look
 * (`attention` / `critical`) — never while it is fine, which is what lets a row
 * with a remedy still fold into the quiet card.
 */
function withRemedy(
  row: SealedRow,
  level: ReturnType<typeof levelOf>,
  actions: ReactNode,
  remedy: ReactNode,
): ReactNode {
  if (remedy === undefined || (level !== "attention" && level !== "critical"))
    return actions;
  return (
    <>
      {actions}
      <ContributedPart row={row}>{remedy}</ContributedPart>
    </>
  );
}

/**
 * The row's leading column: ONE fixed-size box for both row kinds, so every
 * title starts at the same x whether the row leads with a dot or an icon. An
 * empty one is the indent under it — the spacer IS the box it reserves room
 * for, so the two cannot drift apart.
 */
function LeadBox({ children }: { children?: ReactNode }) {
  return <Center className={cn(rigidClass(), "size-4")}>{children}</Center>;
}

/**
 * Every row's content: the lead box sits in the TITLE's line (so it centres on
 * the title, not on the whole block), and the summary — then a status row's
 * glance — hangs under the title, indented by an empty lead box.
 */
function RowText({
  leading,
  title,
  summary,
  summaryClassName,
  extra,
}: {
  leading: ReactNode;
  title: string;
  summary: string;
  summaryClassName: ClassName;
  extra?: ReactNode;
}) {
  return (
    <Fill>
      <Stack gap="2xs">
        <Line className="gap-sm">
          <LeadBox>{leading}</LeadBox>
          <Text variant="label">{title}</Text>
        </Line>
        <Stack direction="row" gap="sm" align="start">
          <LeadBox />
          <Fill>
            <Stack gap="xs">
              <Text variant="caption" className={summaryClassName}>
                {summary}
              </Text>
              {extra}
            </Stack>
          </Fill>
        </Stack>
      </Stack>
    </Fill>
  );
}

/**
 * A row with nothing to expand. A plain line, not a `Row`: `Row` paints a hover
 * tint, which on a row that does nothing when clicked would promise an action
 * that is not there. Same padding and gap as `Row`, so both kinds align.
 */
function StaticRow({
  actions,
  className,
  children,
}: {
  actions: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Line className={cn("gap-sm rounded-md p-row", className)}>
      {children}
      {actions ? (
        <RowActions pin={null} alwaysVisible className={rigidClass()}>
          {actions}
        </RowActions>
      ) : null}
    </Line>
  );
}

/** The clickable header of an expandable row: the whole row toggles its detail. */
function ExpandTrigger({
  actions,
  children,
}: {
  actions: ReactNode;
  children: ReactNode;
}) {
  const ctx = useCollapsibleContext();
  if (!ctx) {
    throw new Error(
      "health-report: ExpandTrigger rendered outside <Collapsible>",
    );
  }
  return (
    <Row
      onClick={ctx.toggle}
      aria-expanded={ctx.open}
      aria-controls={ctx.contentId}
      actions={actions}
      actionsAlwaysVisible
    >
      {children}
      <CollapsibleChevron className="text-muted-foreground" />
    </Row>
  );
}

/**
 * A row's glance, told whether the row is expanded: read off the row's own
 * `Collapsible`, absent on a row with no detail (never expanded).
 */
function RowGlance({ glance }: { glance: NonNullable<LineParts["glance"]> }) {
  const expanded = useCollapsibleContext()?.open ?? false;
  return glance(expanded);
}

/** The line's name in its current state: the state's own `title`, else the item's or row's. */
function titleOf(line: StatusLine, status: ReportedStatus): string {
  if (status !== undefined && "title" in status && status.title !== undefined)
    return status.title;
  return line.kind === "set-item" ? line.title : line.row.title;
}

/** The summary line; a row not reported yet (or saying nothing) is "Checking…". */
function summaryOf(status: ReportedStatus): string {
  return status?.summary ?? "Checking…";
}

/**
 * A status line: dot, title, summary, optional glance, optional trailing
 * actions. A line whose row declares a `component` is expandable — the chevron
 * exists exactly when a detail does (detail-sections' rule) — and its detail is
 * mounted only while expanded. A row set's item is drawn exactly like a status
 * row, its parts told which item they are for.
 */
export function StatusRowView({
  line,
  status,
}: {
  line: StatusLine;
  status: ReportedStatus;
}) {
  const { row } = line;
  const level = levelOf(status);
  const parts = partsOf(line);
  return (
    <HealthLineView
      status={status}
      title={titleOf(line, status)}
      glance={
        parts.glance ? (
          <ContributedPart row={row}>
            <RowGlance glance={parts.glance} />
          </ContributedPart>
        ) : undefined
      }
      actions={withRemedy(
        row,
        level,
        contributedActions(row, parts.actions),
        parts.remedy,
      )}
      detail={parts.detail}
    />
  );
}

/**
 * One line of the report as it is drawn, given its parts already rendered:
 * the dot for `status`, `title`, the summary (tinted while it needs a look),
 * `glance` under it, `actions` trailing, and — when `detail` is given — the
 * chevron and the detail, mounted only while expanded (`defaultOpen` starts it
 * so). The report's own lines are drawn through it, so a surface that shows a
 * row on its own (an exhibit of a contributor's row) is the row, pixel for
 * pixel — never a lookalike.
 */
export function HealthLineView({
  status,
  title,
  glance,
  actions,
  detail,
  defaultOpen = false,
}: {
  status: ReportedStatus;
  title: string;
  glance?: ReactNode;
  actions?: ReactNode;
  detail?: () => ReactNode;
  defaultOpen?: boolean;
}) {
  const level = levelOf(status);
  // The dot at the header's size, so it reads at a glance beside the title.
  // A check that does not apply here is hollow: no status, nothing live.
  const leading = (
    <ControlSizeProvider size="lg">
      {level === "not-applicable" || level === "absent" ? (
        <StatusDot ringClass={cn("border-muted-foreground/50")} />
      ) : (
        <HealthDot level={level} pulsing={isPulsing(status)} />
      )}
    </ControlSizeProvider>
  );
  const text = (
    <RowText
      leading={leading}
      title={title}
      summary={summaryOf(status)}
      summaryClassName={SUMMARY_CLASS[level]}
      extra={glance}
    />
  );

  if (!detail) {
    return <StaticRow actions={actions}>{text}</StaticRow>;
  }
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <ExpandTrigger actions={actions}>{text}</ExpandTrigger>
      <CollapsibleContent className="p-row">
        {/* Indented by an empty lead box, so the detail starts under the title. */}
        <Stack direction="row" gap="sm" align="start">
          <LeadBox />
          <Fill>{detail()}</Fill>
        </Stack>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * The quiet rows folded into one card (`foldQuietRows`): a green dot, one
 * generic title (never the folded rows' titles: the list grows with every
 * contributor, and a list of names reads like the problem), "All N normal" —
 * and, expanded, each row as it would read
 * on its own, indented under the card's title. The rows are passed in already
 * rendered, each in its own boundary.
 */
export function QuietRowsView({
  lines,
  statuses,
  children,
}: {
  lines: ReadonlyArray<StatusLine>;
  statuses: Readonly<Record<string, ReportedStatus>>;
  children: ReactNode;
}) {
  const leading = (
    <ControlSizeProvider size="lg">
      <HealthDot
        level="ok"
        pulsing={lines.some((line) => isTransitioning(statuses[line.id]))}
      />
    </ControlSizeProvider>
  );
  return (
    <Collapsible>
      <ExpandTrigger actions={null}>
        <RowText
          leading={leading}
          title="System checks"
          summary={`All ${lines.length} normal`}
          summaryClassName={SUMMARY_CLASS.ok}
        />
      </ExpandTrigger>
      <CollapsibleContent>
        <Stack direction="row" gap="sm" align="start" className="px-row">
          <LeadBox />
          <Fill>
            <Stack gap="2xs">{children}</Stack>
          </Fill>
        </Stack>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * An info row: an icon instead of a dot, and no state. Its `useInfo` hook runs
 * here, so only while the report is open.
 */
export function InfoRowView({
  row,
  useInfo,
}: {
  row: SealedInfoRow;
  /** `row.useInfo`, passed on its own so the hook call reads as one. */
  useInfo: SealedInfoRow["useInfo"];
}) {
  const info = useInfo();
  const icon = row.icon;
  const Actions = row.actions;
  return (
    <StaticRow
      className="bg-muted/40"
      actions={contributedActions(row, Actions && <Actions />)}
    >
      <RowText
        leading={<Icon icon={icon} className="size-4 text-muted-foreground" />}
        title={info.title}
        summary={info.summary}
        summaryClassName={SUMMARY_CLASS.unknown}
      />
    </StaticRow>
  );
}
