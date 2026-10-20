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
function contributedActions(row: SealedRow): ReactNode {
  const Actions = row.actions;
  if (!Actions) return null;
  return (
    <ContributedPart row={row}>
      <Actions />
    </ContributedPart>
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
 * A status row: dot, title, summary, optional glance, optional trailing actions.
 * A row that declares a `component` is expandable — the chevron exists exactly
 * when a detail does (detail-sections' rule) — and its detail is mounted only
 * while expanded.
 */
export function StatusRowView({
  row,
  status,
}: {
  row: SealedStatusRow;
  status: ReportedStatus;
}) {
  const level = levelOf(status);
  const Glance = row.glance;
  // The dot at the header's size, so it reads at a glance beside the title.
  // A check that does not apply here is hollow: no status, nothing live.
  const leading = (
    <ControlSizeProvider size="lg">
      {level === "not-applicable" ? (
        <StatusDot ringClass={cn("border-muted-foreground/50")} />
      ) : (
        <HealthDot level={level} pulsing={isPulsing(status)} />
      )}
    </ControlSizeProvider>
  );
  const actions = contributedActions(row);
  const text = (
    <RowText
      leading={leading}
      title={row.title}
      summary={status?.summary ?? "Checking…"}
      summaryClassName={SUMMARY_CLASS[level]}
      extra={
        Glance ? (
          <ContributedPart row={row}>
            <Glance />
          </ContributedPart>
        ) : undefined
      }
    />
  );

  if (!row.component) {
    return <StaticRow actions={actions}>{text}</StaticRow>;
  }
  return (
    <Collapsible>
      <ExpandTrigger actions={actions}>{text}</ExpandTrigger>
      <CollapsibleContent className="p-row">
        {/* Indented by an empty lead box, so the detail starts under the title. */}
        <Stack direction="row" gap="sm" align="start">
          <LeadBox />
          <Fill>
            {renderIsolated(HealthReport.Row, row as unknown as Contribution)}
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
  return (
    <StaticRow className="bg-muted/40" actions={contributedActions(row)}>
      <RowText
        leading={<Icon icon={icon} className="size-4 text-muted-foreground" />}
        title={info.title}
        summary={info.summary}
        summaryClassName={SUMMARY_CLASS.unknown}
      />
    </StaticRow>
  );
}
