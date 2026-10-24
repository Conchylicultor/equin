import {
  Button,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  Stack,
  Inset,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import {
  useProfilerReport,
  startSession,
  stopSession,
} from "../internal/session";
import { registerExcludedComponent } from "../internal/global-api";
import { InitiatorRow } from "./initiator-row";
import { RemountRow } from "./remount-row";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const insightsIcon = symbol("insights");

const SESSION_MAX_MS = 30_000;

export function RenderProfilerPane() {
  const report = useProfilerReport();
  const {
    running,
    totalCommits,
    commitsPerSec,
    durationMs,
    initiators,
    remounts,
  } = report;

  return (
    <Stack gap="none" className="h-full">
      <Inset x="md" y="sm">
        <Stack direction="row" gap="md" align="center" justify="between">
          <Stack direction="row" gap="sm" align="center">
            <Icon
              icon={insightsIcon}
              className="size-4 text-muted-foreground"
            />
            <Text variant="subheading">Render Profiler</Text>
          </Stack>
          <ControlSizeProvider size="sm">
            {running ? (
              <Button variant="destructive" onClick={() => stopSession()}>
                Stop
              </Button>
            ) : (
              <Button
                variant="default"
                onClick={() => startSession({ maxDurationMs: SESSION_MAX_MS })}
              >
                Start
              </Button>
            )}
          </ControlSizeProvider>
        </Stack>
      </Inset>

      <Inset x="md" y="2xs">
        <Text as="div" variant="caption" tone="muted">
          {running
            ? `Running — ${totalCommits} commits · ${commitsPerSec.toFixed(1)}/s · ${(durationMs / 1000).toFixed(1)}s (auto-stops at ${SESSION_MAX_MS / 1000}s)`
            : totalCommits > 0
              ? `Stopped — ${totalCommits} commits · ${commitsPerSec.toFixed(1)}/s over ${(durationMs / 1000).toFixed(1)}s`
              : "Off. Start a session and interact with / idle on the suspect screen."}
        </Text>
      </Inset>

      <Scroll axis="both" fill>
        {report.bridgeMissing ? (
          <Inset pad="md">
            <Placeholder tone="error">
              The React commit bridge isn&apos;t installed (the frontend
              predates this feature). Run ./equin build to rebuild index.html,
              then reload.
            </Placeholder>
          </Inset>
        ) : initiators.length === 0 ? (
          <Inset pad="md">
            <Placeholder>
              {running
                ? "Listening for commits… interact with or idle on the suspect screen."
                : "Start a session and interact with / idle on the suspect screen."}
            </Placeholder>
          </Inset>
        ) : (
          <Stack gap="none">
            <ul className="divide-y">
              {initiators.map((stat) => (
                <InitiatorRow key={stat.signature} stat={stat} />
              ))}
            </ul>
            {(remounts.length > 0 || report.remountTruncated) && (
              <>
                <Inset x="md" y="2xs" className="border-t bg-muted/30">
                  <Text as="div" variant="eyebrow" tone="muted">
                    Remounts
                  </Text>
                </Inset>
                {report.remountTruncated && (
                  <Inset x="md" y="2xs">
                    <Text as="div" variant="caption" tone="muted">
                      Position map hit its cap — some remounts may be missed.
                    </Text>
                  </Inset>
                )}
                <ul className="divide-y">
                  {remounts.map((stat) => (
                    <RemountRow key={stat.positionKey} stat={stat} />
                  ))}
                </ul>
              </>
            )}
          </Stack>
        )}
      </Scroll>
    </Stack>
  );
}

// Self-exclusion: the profiler must never attribute its own UI churn. Register
// at module load (before any session can run).
registerExcludedComponent(RenderProfilerPane);
registerExcludedComponent(InitiatorRow);
