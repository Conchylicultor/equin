import type { ReactElement, ReactNode } from "react";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  EndpointError,
  useEndpointMutation,
} from "@plugins/infra/plugins/endpoints/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { asPath, asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { runBackgroundNowEndpoint, type BackgroundEntry } from "../../core";
import { useEntry } from "../internal/use-entries";
import { SCOPE_LABEL, triggerWords } from "../internal/present";
import { NextRun } from "./next-run";
import { RecentRuns } from "./recent-runs";

/** The detail of one entry, read from the (already loaded) catalog. */
export function EntryDetail({
  kind,
  name,
}: {
  kind: string;
  name: string;
}): ReactElement {
  const result = useEntry(kind, name);
  switch (result.status) {
    case "loading":
      return <Loading variant="rows" />;
    case "error":
      return (
        <ResourceErrorInline
          variant="block"
          subject="the background catalog"
          error={result.error}
          refetch={result.refetch}
        />
      );
    case "ready":
      break;
  }
  const entry = result.data;
  if (entry === null) {
    return (
      <Placeholder tone="error">
        Nothing named {name} runs in this backend any more.
      </Placeholder>
    );
  }
  return <EntryDetailBody entry={entry} />;
}

function EntryDetailBody({ entry }: { entry: BackgroundEntry }): ReactElement {
  const { trigger } = entry;
  return (
    <Stack gap="xl" className="rail-lg">
      <Stack gap="xs">
        <Text variant="eyebrow" tone="muted">
          {entry.group}
          {entry.internal ? " · internal" : ""}
        </Text>
        <Text as="h2" variant="heading">
          {entry.description}
        </Text>
        <Text variant="code" tone="muted">
          {entry.name}
        </Text>
      </Stack>

      {entry.canRunNow ? <RunNow entry={entry} /> : null}

      <Stack gap="sm">
        <Fact label="When">
          {triggerWords(trigger)}
          {trigger.kind === "cron" && !trigger.disabled
            ? ` (${trigger.expr})`
            : ""}
        </Fact>
        {trigger.kind === "cron" && trigger.nextAt !== null ? (
          <Fact label="Next run">
            <NextRun at={new Date(trigger.nextAt)} />
          </Fact>
        ) : null}
        <Fact label="Where">
          {SCOPE_LABEL[entry.scope]}
          {entry.runsHere ? "" : " — not in this worktree"}
        </Fact>
        {entry.history !== null ? (
          <Fact label="Runs here">
            {entry.history.runs} recorded
            {entry.history.failures > 0
              ? `, ${entry.history.failures} failed`
              : ""}
            {entry.history.lastSuccessAt !== null ? (
              <>
                {" · last success "}
                <RelativeTime date={new Date(entry.history.lastSuccessAt)} />
              </>
            ) : null}
          </Fact>
        ) : null}
        {entry.declaredIn !== null ? (
          <Fact label="Declared in">
            <Text variant="code">{asPath(asPluginId(entry.declaredIn))}</Text>
          </Fact>
        ) : null}
        {entry.facts.map((f) => (
          <Fact key={f.label} label={f.label}>
            {f.value}
          </Fact>
        ))}
      </Stack>

      <RecentRuns entry={entry} />
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
      <Text variant="caption" tone="muted" className={`w-28 ${rigidClass()}`}>
        {label}
      </Text>
      <Text variant="caption">{children}</Text>
    </Stack>
  );
}

/**
 * Start it now, in this backend. The Button shows itself pending while the
 * request is in flight; the run itself then appears in Recent runs as it is
 * pushed. A refused request is toasted by the endpoint layer.
 */
function RunNow({ entry }: { entry: BackgroundEntry }): ReactElement {
  const runNow = useEndpointMutation(runBackgroundNowEndpoint);
  return (
    <Stack direction="row" gap="md" align="center">
      <Button
        variant="outline"
        onClick={() =>
          runNow
            .mutateAsync({ body: { kind: entry.kind, name: entry.name } })
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
        Run now
      </Button>
      <Text variant="caption" tone="muted">
        {runNow.isSuccess
          ? "Queued — it appears under Recent runs when it starts."
          : "Runs once in this backend, outside its schedule."}
      </Text>
    </Stack>
  );
}
