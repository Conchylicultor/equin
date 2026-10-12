import { Fragment, useState, type ReactElement } from "react";
import { useConfigResult, useSetConfig } from "@plugins/config_v2/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import {
  ControlPanel,
  ControlPanelPane,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Input } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { reportInvestigationsConfig } from "../../shared/config";
import { reportInvestigationsScope } from "../../shared/live";
import {
  REPORT_SEVERITIES,
  REPORT_SEVERITY_LABELS,
  severityInScope,
  type ReportKindScope,
  type ReportSeverityScope,
} from "../../shared/scope";

const SEVERITY_DESCRIPTION: Record<ReportSeverityScope, string> = {
  error: "Only errors — something broke.",
  warning: "Errors and warnings — slowness and pressure too.",
  everything: "Every report, informational ones included.",
};

// Kinds are listed under their bell variant, most severe first.
const VARIANT_GROUPS = [
  { label: "Error kinds", variants: ["error"] },
  { label: "Warning kinds", variants: ["warning"] },
  { label: "Other kinds", variants: ["info", "success"] },
] as const;

/**
 * Which reports the automation investigates: by severity, by recurrence, and
 * kind by kind — with how many uninvestigated reports match right now, so the
 * choice reads as what it will do.
 */
export function ReportScopeSection(): ReactElement {
  const config = useConfigResult(reportInvestigationsConfig);
  switch (config.status) {
    case "loading":
      return <Loading variant="rows" />;
    case "error":
      return (
        <ResourceErrorInline
          variant="block"
          subject="its scope"
          error={config.error}
          refetch={config.refetch}
        />
      );
    case "ready":
      break;
  }
  const severity = REPORT_SEVERITIES.find((s) => s === config.data.severity);
  if (severity === undefined) {
    throw new Error(
      `report-investigations: severity "${config.data.severity}" is not one of ${REPORT_SEVERITIES.join(", ")}`,
    );
  }
  return (
    <ScopePanel
      severity={severity}
      minCount={config.data.minCount}
      excludedKinds={config.data.excludedKinds}
    />
  );
}

function ScopePanel({
  severity,
  minCount,
  excludedKinds,
}: {
  severity: ReportSeverityScope;
  minCount: number;
  excludedKinds: readonly string[];
}): ReactElement {
  const set = useSetConfig(reportInvestigationsConfig);
  const scope = useLive(reportInvestigationsScope, { minCount });
  const excluded = new Set(excludedKinds);
  const inScope = (k: ReportKindScope): boolean =>
    severityInScope(k.variant, severity) && !excluded.has(k.kind);
  return (
    <ControlPanelPane label="Which reports">
      <ControlPanel.Section label="Which reports">
        {REPORT_SEVERITIES.map((s) => (
          <ControlPanel.Row
            key={s}
            select="radio"
            checked={severity === s}
            onSelect={() => set("severity", s)}
            description={SEVERITY_DESCRIPTION[s]}
          >
            {REPORT_SEVERITY_LABELS[s]}
          </ControlPanel.Row>
        ))}
        <ControlPanel.Setting
          label="Occurred at least"
          hint="A report qualifies once it has happened this many times; 1 = on its first occurrence."
          fit="field"
          control={
            <TimesInput value={minCount} onCommit={(n) => set("minCount", n)} />
          }
        />
      </ControlPanel.Section>
      {scope.status === "loading" ? (
        <Loading variant="rows" />
      ) : scope.status === "error" ? (
        <ResourceErrorInline
          variant="block"
          subject="the report kinds"
          error={scope.error}
          refetch={scope.refetch}
        />
      ) : (
        <ControlPanel.Section
          label="Kinds"
          description={matchWords(scope.data.kinds.filter(inScope))}
        >
          {VARIANT_GROUPS.map((group) => {
            const kinds = scope.data.kinds.filter((k) =>
              (group.variants as readonly string[]).includes(k.variant),
            );
            if (kinds.length === 0) return null;
            return (
              <Fragment key={group.label}>
                <ControlPanel.Subhead>{group.label}</ControlPanel.Subhead>
                {kinds.map((k) => {
                  const bySeverity = severityInScope(k.variant, severity);
                  return (
                    <ControlPanel.Row
                      key={k.kind}
                      select="check"
                      checked={inScope(k)}
                      disabled={!bySeverity}
                      hint={
                        bySeverity ? undefined : "Outside the severity above."
                      }
                      trailing={k.open > 0 ? `${k.open} open` : undefined}
                      onSelect={() =>
                        set(
                          "excludedKinds",
                          excluded.has(k.kind)
                            ? excludedKinds.filter((x) => x !== k.kind)
                            : [...excludedKinds, k.kind],
                        )
                      }
                    >
                      {k.kind}
                    </ControlPanel.Row>
                  );
                })}
              </Fragment>
            );
          })}
        </ControlPanel.Section>
      )}
    </ControlPanelPane>
  );
}

function matchWords(kinds: readonly ReportKindScope[]): string {
  const total = kinds.reduce((n, k) => n + k.open, 0);
  if (total === 0) return "No uninvestigated report matches right now.";
  const names = kinds.filter((k) => k.open > 0).map((k) => k.kind);
  return `${total} uninvestigated report${total === 1 ? "" : "s"} match right now (${names.join(", ")}) — the next run batches them into one task.`;
}

/** A whole number of occurrences, written once the person is done typing. */
function TimesInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (n: number) => void;
}): ReactElement {
  const [draft, setDraft] = useState(String(value));
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(String(value));
  }
  const commit = (): void => {
    const n = Number(draft);
    if (Number.isInteger(n) && n >= 1 && n !== value) onCommit(n);
    else setDraft(String(value));
  };
  return (
    <Input
      type="number"
      min={1}
      value={draft}
      aria-label="Occurred at least this many times"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}
