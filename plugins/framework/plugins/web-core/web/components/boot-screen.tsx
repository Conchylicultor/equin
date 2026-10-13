import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { ElapsedTime } from "@plugins/primitives/plugins/relative-time/web";
import type { BootTaskStatus } from "../boot-tasks";
import "./boot-screen.css";

export type BootScreenProps =
  | { phase: "loading-code" }
  | {
      phase: "boot-tasks";
      tasks: readonly BootTaskStatus[];
      onContinue: () => void;
    };

// What the screen says, derived from the task statuses. Only a `block` task can
// turn it into an error: a `continue` task that fails or runs late is reported
// and boot proceeds without it.
type View =
  | { kind: "waiting"; title: string; pending: string[] }
  | { kind: "stuck"; overdue: string[] }
  | { kind: "failed"; failures: { label: string; message: string }[] };

function viewOf(props: BootScreenProps): View {
  if (props.phase === "loading-code") {
    return { kind: "waiting", title: "Loading the app…", pending: [] };
  }
  const blocking = props.tasks.filter((t) => t.ifUnavailable === "block");
  const failures = blocking.flatMap((t) =>
    t.outcome.kind === "failed"
      ? [{ label: t.label, message: t.outcome.message }]
      : [],
  );
  if (failures.length) return { kind: "failed", failures };
  const overdue = blocking
    .filter((t) => t.outcome.kind === "overdue")
    .map((t) => t.label);
  if (overdue.length) return { kind: "stuck", overdue };
  return {
    kind: "waiting",
    title: "Waiting for the server…",
    pending: props.tasks
      .filter((t) => t.outcome.kind !== "done")
      .map((t) => t.label),
  };
}

/**
 * What the page shows while boot is not done: never nothing. Waiting fades in
 * after a 1s grace (see boot-screen.css), naming what it waits for and for how
 * long; a failed or overdue `block` task is a loud error state at once, with
 * Retry and Continue anyway. `data-boot-state` is the e2e hook.
 */
export function BootScreen(props: BootScreenProps) {
  const view = viewOf(props);
  // Waited since the navigation started — what the user has been looking at.
  const since = new Date(performance.timeOrigin);
  return (
    <Center
      data-boot-state={view.kind}
      role={view.kind === "waiting" ? "status" : "alert"}
      // The boot root fills the viewport: no app shell exists yet to size it.
      className="h-dvh p-lg"
    >
      {view.kind === "waiting" ? (
        <Stack gap="xs" align="center" className="boot-screen-delayed">
          <Text variant="body" tone="muted">
            {view.title}
          </Text>
          <Text variant="caption" tone="faint">
            {view.pending.length ? `${view.pending.join(", ")} · ` : ""}
            <ElapsedTime since={since} />
          </Text>
        </Stack>
      ) : (
        <Stack gap="md" align="center">
          <Stack gap="xs" align="center">
            <Text variant="heading" tone="destructive">
              {view.kind === "stuck"
                ? "The server isn't answering"
                : "Couldn't load the app's data"}
            </Text>
            {view.kind === "stuck" ? (
              <Text variant="body" tone="muted">
                {view.overdue.join(", ")} still pending after{" "}
                <ElapsedTime since={since} />
              </Text>
            ) : (
              view.failures.map((f) => (
                <Text key={f.label} variant="body" tone="muted">
                  {f.label} failed: {f.message}
                </Text>
              ))
            )}
            <Text variant="caption" tone="faint">
              {view.kind === "stuck"
                ? "This page continues on its own if the server answers."
                : "Reported. Retry reloads the page."}
            </Text>
          </Stack>
          <Stack direction="row" gap="sm">
            {/* Both outline: the hairline still draws before a theme exists
                (cold-cache boot), where a filled button's fill is undefined. */}
            <Button variant="outline" onClick={() => window.location.reload()}>
              Retry
            </Button>
            {props.phase === "boot-tasks" && (
              <Button variant="outline" onClick={props.onContinue}>
                Continue anyway
              </Button>
            )}
          </Stack>
        </Stack>
      )}
    </Center>
  );
}
