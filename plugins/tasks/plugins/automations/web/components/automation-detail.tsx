import type { ReactElement, ReactNode } from "react";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import { useConfigResult } from "@plugins/config_v2/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import {
  EndpointError,
  useEndpointMutation,
} from "@plugins/infra/plugins/endpoints/web";
import { runBackgroundNowEndpoint } from "@plugins/infra/plugins/background/plugins/catalog/core";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  readAutomationSettings,
  type AutomationConfigFields,
  type AutomationEntry,
} from "../../core";
import {
  useAutomation,
  useAutomationConfigDescriptor,
} from "../internal/use-automations";
import { Automations } from "../internal/slots";
import { NextRunWords, useAutomationJob } from "./schedule";
import { AutomationHistory } from "./automation-history";
import { BehaviorSection, SourcesSection } from "./behavior-section";
import { TriggerSection } from "./trigger-section";
import { PromptSection } from "./prompt-section";

const playIcon = symbol("play-arrow");

/** One automation, read from the (already loaded) catalog and its config. */
export function AutomationDetail({
  automationId,
}: {
  automationId: string;
}): ReactElement {
  const result = useAutomation(automationId);
  switch (result.status) {
    case "loading":
      return <Loading variant="rows" />;
    case "error":
      return (
        <ResourceErrorInline
          variant="block"
          subject="the automations"
          error={result.error}
          refetch={result.refetch}
        />
      );
    case "unavailable":
      // The catalog is the machine half's: an in-browser server has none.
      return <Placeholder>{result.message}</Placeholder>;
    case "ready":
      break;
  }
  if (result.data === null) {
    return (
      <Placeholder tone="error">
        No automation named {automationId} is installed any more.
      </Placeholder>
    );
  }
  return <AutomationDetailBody entry={result.data} />;
}

function AutomationDetailBody({
  entry,
}: {
  entry: AutomationEntry;
}): ReactElement {
  const job = useAutomationJob(entry.trigger);
  const descriptor = useAutomationConfigDescriptor(entry.id);
  return (
    <Stack gap="xl" className="rail-lg">
      <Stack gap="sm">
        <Stack direction="row" gap="sm" align="center">
          <Icon icon={entry.icon} className={`size-5 ${rigidClass()}`} />
          <Fill>
            <Line>
              <Text as="h2" variant="heading">
                {entry.label}
              </Text>
            </Line>
          </Fill>
          {entry.enabled ? (
            <Badge variant="success">On</Badge>
          ) : (
            <Badge variant="muted">Off</Badge>
          )}
        </Stack>
        <Text variant="body" tone="muted">
          {entry.description}
        </Text>
      </Stack>

      <Stack gap="sm">
        <Fact label="When">
          {entry.trigger.words}
          {entry.enabled && entry.trigger.current === "schedule" ? (
            <NextRunWords job={job} prefix=" · " />
          ) : null}
        </Fact>
        <Fact label="Job">
          <Text variant="code" tone="muted">
            {entry.trigger.jobName}
          </Text>
        </Fact>
      </Stack>

      <RunNow entry={entry} />

      {descriptor === null ? (
        <Placeholder tone="error">
          {`No web plugin contributes the config of "${entry.id}" — its plugin must spread automationConfigContributions(…) into its web contributions.`}
        </Placeholder>
      ) : (
        <AutomationSettingsSections entry={entry} descriptor={descriptor} />
      )}

      <AutomationHistory automationId={entry.id} />
    </Stack>
  );
}

/** Every editable part of the automation, once its config document is known. */
function AutomationSettingsSections({
  entry,
  descriptor,
}: {
  entry: AutomationEntry;
  descriptor: ConfigDescriptor<AutomationConfigFields>;
}): ReactElement {
  const config = useConfigResult(descriptor);
  switch (config.status) {
    case "loading":
      return <Loading variant="rows" />;
    case "error":
      return (
        <ResourceErrorInline
          variant="block"
          subject="its settings"
          error={config.error}
          refetch={config.refetch}
        />
      );
    case "ready":
      break;
  }
  const settings = readAutomationSettings(config.data);
  return (
    <Stack gap="xl">
      <BehaviorSection
        entry={entry}
        descriptor={descriptor}
        settings={settings}
      />
      <TriggerSection
        entry={entry}
        descriptor={descriptor}
        settings={settings}
      />
      <Automations.Section.Render>
        {(section) =>
          section.automationId === entry.id ? <section.component /> : null
        }
      </Automations.Section.Render>
      <SourcesSection
        entry={entry}
        descriptor={descriptor}
        settings={settings}
      />
      <PromptSection
        entry={entry}
        descriptor={descriptor}
        settings={settings}
      />
    </Stack>
  );
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <Stack direction="row" gap="md" align="start">
      <Text variant="caption" tone="muted" className={`w-20 ${rigidClass()}`}>
        {label}
      </Text>
      <Text variant="caption">{children}</Text>
    </Stack>
  );
}

/**
 * Run its job now, outside its trigger — through Background activity's Run
 * now, so it is the same run the trigger would start (settings, dedupe and
 * all). Offered only where the job's provider offers it, and only while the
 * automation is on: an off automation's run files nothing.
 */
function RunNow({ entry }: { entry: AutomationEntry }): ReactElement {
  const job = useAutomationJob(entry.trigger);
  const runNow = useEndpointMutation(runBackgroundNowEndpoint);
  const canRun =
    job.status === "ready" && job.data !== null && job.data.canRunNow;
  const why = !entry.enabled
    ? "Turn it on to run it."
    : job.status === "loading"
      ? "Reading its job…"
      : job.status === "ready" && job.data !== null && !job.data.runsHere
        ? "Its job runs on main — start it from there."
        : !canRun
          ? "Its job cannot be started from here."
          : runNow.isSuccess
            ? "Queued — a task it files appears under History."
            : "Checks once now, outside its trigger.";
  return (
    <Stack direction="row" gap="md" align="center">
      <Button
        variant="outline"
        disabled={!entry.enabled || !canRun}
        onClick={() =>
          runNow
            .mutateAsync({
              body: { kind: "job", name: entry.trigger.jobName },
            })
            .then(
              () => undefined,
              (err: unknown) => {
                // Already shown (the endpoint layer toasts a failed request);
                // anything else is a bug and must stay loud.
                if (err instanceof EndpointError) return;
                throw err;
              },
            )
        }
      >
        <Icon icon={playIcon} />
        Run now
      </Button>
      <Text variant="caption" tone="muted">
        {why}
      </Text>
    </Stack>
  );
}
