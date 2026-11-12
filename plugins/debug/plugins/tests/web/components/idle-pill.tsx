import type { ReactElement } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  hostIdle,
  IDLE_SUSTAIN_MS,
  type HostIdle,
} from "@plugins/infra/plugins/host/plugins/idle/core";

const SUSTAIN_MIN = Math.round(IDLE_SUSTAIN_MS / 60_000);
const RULE = `Idle runs start once no agent is working, no op is running and the machine is not under duress, for ${SUSTAIN_MIN} min — and stop the moment one of those ends.`;

/** The pill's words for a known idle state. */
export function idlePillText(idle: HostIdle): {
  text: string;
  running: boolean;
} {
  switch (idle.state) {
    case "unevaluated":
      return { text: "Idle run waiting · not checked yet", running: false };
    case "idle":
      return { text: "Machine idle · running stale tests", running: true };
    case "settling":
      return {
        text: `Idle run waiting · machine quiet, ${SUSTAIN_MIN} min to go at most`,
        running: false,
      };
    case "busy": {
      const why = idle.blockers.filter((b) => b.busy).map((b) => b.label);
      return {
        text: `Idle run waiting · ${why.length > 0 ? why.join(" · ") : "machine busy"}`,
        running: false,
      };
    }
  }
}

/**
 * Whether the machine is idle enough for Debug → Tests' idle runs, and if not,
 * what holds it: "Idle run waiting · 3 agents working". Main's backend is the
 * one that watches; anywhere else the value is refused `main-only`, and the
 * pill says so instead of guessing.
 */
export function IdlePill(): ReactElement {
  const idle = useLive(hostIdle);
  if (idle.status === "loading")
    return <Loading label="Checking whether the machine is idle…" />;
  if (idle.status === "error") {
    if (idle.error.kind === "refused" && idle.error.code === "main-only")
      return (
        <Badge
          shape="pill"
          variant="muted"
          icon={<StatusDot colorClass="bg-muted-foreground" />}
          tooltip={`${RULE} Main's backend watches the machine; this checkout's page does not.`}
        >
          Idle runs: on main only
        </Badge>
      );
    return (
      <ResourceErrorInline
        variant="inline"
        subject="whether the machine is idle"
        error={idle.error}
        refetch={idle.refetch}
      />
    );
  }
  const { text, running } = idlePillText(idle.data);
  return (
    <Badge
      shape="pill"
      variant={running ? "success" : "muted"}
      icon={
        <StatusDot
          colorClass={running ? "bg-success" : "bg-muted-foreground"}
        />
      }
      tooltip={RULE}
    >
      {text}
    </Badge>
  );
}
