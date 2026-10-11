import type { ReactElement } from "react";
import { useSetConfig } from "@plugins/config_v2/web";
import {
  ControlPanel,
  ControlPanelPane,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { ModelSelect } from "@plugins/conversations/plugins/model-provider/web";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import {
  isLaunchAutomationConfig,
  MAX_LAUNCH_CONCURRENCY,
  MAX_LAUNCHES,
  PUSH_POLICIES,
  PUSH_POLICY_LABELS,
  type AutomationEntry,
  type LaunchAutomationConfigFields,
  type PushPolicy,
} from "../../core";
import { ChoiceSelect } from "./choice-select";
import type { AutomationSectionProps } from "./section-props";

const PUSH_DESCRIPTION: Record<PushPolicy, string> = {
  never: "The agent stops at a ready branch and flags it; you review and push.",
  safe: "Pushes a small, local fix that changes no behaviour and needs no design choice. Anything else waits for you, with a note saying what needs a decision.",
  checks: "The agent lands its work on main as soon as every check passes.",
};

/**
 * Whether it is on, what its agent may do with its work, and which model it
 * launches. Each control writes its one field of the automation's config.
 */
export function BehaviorSection({
  entry,
  descriptor,
  settings,
}: AutomationSectionProps): ReactElement {
  const set = useSetConfig(descriptor);
  return (
    <ControlPanelPane label={`${entry.label} behavior`}>
      <ControlPanel.Section label="Behavior">
        <ControlPanel.Row
          select="switch"
          checked={settings.enabled}
          onSelect={() => set("enabled", !settings.enabled)}
          description={
            entry.kind === "launch"
              ? launchEnabledWords(entry, settings.enabled)
              : settings.enabled
                ? "Files a task and starts its agent when it finds work."
                : "Files nothing until you turn it on."
          }
        >
          Enabled
        </ControlPanel.Row>
        {entry.kind === "launch" ? (
          <ConcurrencySetting entry={entry} descriptor={descriptor} />
        ) : null}
        <ControlPanel.Setting
          label="Model"
          hint="Used for every agent this automation launches."
          fit="field"
          control={
            <ModelSelect
              allowOff={false}
              value={settings.model}
              onChange={(model) => set("model", model)}
              ariaLabel="Model"
            />
          }
        />
      </ControlPanel.Section>
      <ControlPanel.Section label="Push">
        {PUSH_POLICIES.map((policy) => (
          <ControlPanel.Row
            key={policy}
            select="radio"
            checked={settings.push === policy}
            onSelect={() => set("push", policy)}
            description={PUSH_DESCRIPTION[policy]}
          >
            {PUSH_POLICY_LABELS[policy]}
          </ControlPanel.Row>
        ))}
      </ControlPanel.Section>
    </ControlPanelPane>
  );
}

type LaunchEntry = Extract<AutomationEntry, { kind: "launch" }>;

function launchEnabledWords(entry: LaunchEntry, enabled: boolean): string {
  const approved =
    entry.approvedCount === 0
      ? "Nothing is approved, so it would launch nothing."
      : `${entry.approvedCount} approved and waiting.`;
  return enabled
    ? `Starts agents on the tasks you approved, ${entry.concurrency} at a time — ${entry.launchedInBatch} of at most ${entry.maxLaunches} launched, then it turns itself off. ${approved}`
    : `Starts nothing until you turn it on, and then only tasks you approved. Agents already running finish. ${approved}`;
}

const CONCURRENCY_OPTIONS = Array.from(
  { length: MAX_LAUNCH_CONCURRENCY },
  (_, i) => String(i + 1),
);

/**
 * How many of a launch-kind automation's agents run at once — and how many do
 * now. Lowering it below what runs stops nothing: the next one waits.
 */
function ConcurrencySetting({
  entry,
  descriptor,
}: {
  entry: Extract<AutomationEntry, { kind: "launch" }>;
  descriptor: AutomationSectionProps["descriptor"];
}): ReactElement {
  if (!isLaunchAutomationConfig(descriptor)) {
    throw new Error(
      `automation ${entry.id} is launch-kind but its config has no concurrency — declare it with defineLaunchAutomationConfig`,
    );
  }
  return (
    <>
      <LaunchConcurrency entry={entry} descriptor={descriptor} />
      <MaxLaunchesSetting entry={entry} descriptor={descriptor} />
    </>
  );
}

function LaunchConcurrency({
  entry,
  descriptor,
}: {
  entry: Extract<AutomationEntry, { kind: "launch" }>;
  descriptor: ConfigDescriptor<LaunchAutomationConfigFields>;
}): ReactElement {
  const set = useSetConfig(descriptor);
  return (
    <ControlPanel.Setting
      label="At once"
      hint={`${entry.runningTaskIds.length} running now. The next one starts when one finishes or reports.`}
      fit="field"
      control={
        <ChoiceSelect
          ariaLabel="Agents at once"
          value={String(entry.concurrency)}
          options={CONCURRENCY_OPTIONS.map((n) => ({ value: n, label: n }))}
          onChange={(n) => set("concurrency", Number(n))}
        />
      }
    />
  );
}

const MAX_LAUNCHES_OPTIONS = Array.from({ length: MAX_LAUNCHES }, (_, i) =>
  String(i + 1),
);

/**
 * How many approved tasks a launch-kind automation launches once turned on,
 * before it turns itself off — and how many it has this time.
 */
function MaxLaunchesSetting({
  entry,
  descriptor,
}: {
  entry: LaunchEntry;
  descriptor: ConfigDescriptor<LaunchAutomationConfigFields>;
}): ReactElement {
  const set = useSetConfig(descriptor);
  return (
    <ControlPanel.Setting
      label="In total"
      hint={
        entry.enabled
          ? `${entry.launchedInBatch} launched since it was turned on. At ${entry.maxLaunches} it turns itself off; turning it back on starts a new count.`
          : "Launches at most this many approved tasks once turned on, then turns itself off."
      }
      fit="field"
      control={
        <ChoiceSelect
          ariaLabel="Launches in total"
          value={String(entry.maxLaunches)}
          options={MAX_LAUNCHES_OPTIONS.map((n) => ({ value: n, label: n }))}
          onChange={(n) => set("maxLaunches", Number(n))}
        />
      }
    />
  );
}

/**
 * Which of its declared sources take part. A source added later takes part
 * until it is excluded. Nothing for an automation that declares none.
 */
export function SourcesSection({
  entry,
  descriptor,
  settings,
}: AutomationSectionProps): ReactElement | null {
  const set = useSetConfig(descriptor);
  if (entry.sources.length === 0) return null;
  const excluded = new Set(settings.excludedSources);
  return (
    <ControlPanelPane label={`${entry.label} sources`}>
      <ControlPanel.Section
        label="Sources"
        description="Only the included sources are checked. A source added later is included until you exclude it."
      >
        {entry.sources.map((source) => (
          <ControlPanel.Row
            key={source.id}
            select="check"
            checked={!excluded.has(source.id)}
            onSelect={() =>
              set(
                "excludedSources",
                excluded.has(source.id)
                  ? settings.excludedSources.filter((id) => id !== source.id)
                  : [...settings.excludedSources, source.id],
              )
            }
          >
            {source.label}
          </ControlPanel.Row>
        ))}
      </ControlPanel.Section>
    </ControlPanelPane>
  );
}
