import type { ReactNode } from "react";
import type { LoadTiming } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  loadSummary,
  loadTone,
  seconds,
  type LoadTone,
} from "../internal/load";

const TONE: Record<LoadTone, { dot: string; text: string }> = {
  ok: { dot: "bg-success", text: "bg-muted text-muted-foreground" },
  warn: { dot: "bg-warning", text: "bg-muted text-warning" },
  bad: { dot: "bg-destructive", text: "bg-muted text-destructive" },
};

/**
 * How long the visit's page load took, on its row: the ready time in its
 * tone, every measured phase on hover. A load that never got ready on screen
 * (a background tab) shows its server time alone, untoned; no load recorded
 * draws nothing — never "0 s".
 */
export function LoadChip({ load }: { load: LoadTiming | null }): ReactNode {
  if (load === null) return null;
  if (load.readyMs === null)
    return load.ttfbMs === null ? null : (
      <Badge shape="pill" tooltip={loadSummary(load)}>
        server {load.ttfbMs} ms
      </Badge>
    );
  const tone = TONE[loadTone(load.readyMs)];
  return (
    <Badge
      shape="pill"
      colorClass={tone.text}
      tooltip={loadSummary(load)}
      icon={
        <ControlSizeProvider size="sm">
          <StatusDot colorClass={tone.dot} />
        </ControlSizeProvider>
      }
    >
      {seconds(load.readyMs, 1)}
    </Badge>
  );
}
