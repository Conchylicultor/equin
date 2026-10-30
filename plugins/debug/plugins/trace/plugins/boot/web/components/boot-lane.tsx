import { type ReactElement } from "react";
import {
  BootSectionSchema,
  type BootGateway,
  type BootMemoryCheckpoint,
  type BootSection,
  type BootSpan,
} from "@plugins/debug/plugins/trace/plugins/boot/core";
import {
  GanttContainer,
  MultiSpanLane,
  formatDuration,
  type SpanBar,
} from "@plugins/debug/plugins/profiling/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Text, SectionLabel } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import type {
  TraceLaneProps,
  TraceSelection,
} from "@plugins/debug/plugins/trace/plugins/engine/web";

// Categorical color per boot phase (fill = "what", never state — the op-gantt
// convention). Every literal appears here so Tailwind extracts them all; an
// unknown phase (a newer backend's addition) hashes into the same palette.
const PHASE_COLORS: Record<string, string> = {
  register: "bg-categorical-1",
  awaitPgReady: "bg-categorical-2",
  runMigrations: "bg-categorical-3",
  routePopulation: "bg-categorical-4",
  socketBind: "bg-categorical-5",
  onReadyBlocking: "bg-categorical-6",
  onReady: "bg-categorical-7",
  onAllReady: "bg-categorical-8",
  settled: "bg-categorical-9",
  onSettled: "bg-categorical-9",
  warmup: "bg-categorical-9",
};
const PHASE_PALETTE = [
  "bg-categorical-1",
  "bg-categorical-2",
  "bg-categorical-3",
  "bg-categorical-4",
  "bg-categorical-5",
  "bg-categorical-6",
  "bg-categorical-7",
  "bg-categorical-8",
] as const;

function phaseColorClass(phase: string): string {
  const known = PHASE_COLORS[phase];
  if (known) return known;
  let h = 0;
  for (let i = 0; i < phase.length; i++) h = (h * 31 + phase.charCodeAt(i)) | 0;
  return PHASE_PALETTE[Math.abs(h) % PHASE_PALETTE.length]!;
}

// The gateway epoch-ms stamps re-anchored onto the boot axis (0 = wallStartMs).
// spawnRequestedAt precedes process start, so startMs is legitimately NEGATIVE.
interface GatewayWindow {
  startMs: number;
  spawnedMs: number | null;
  endMs: number;
}

function gatewayWindow(section: BootSection): GatewayWindow | null {
  const gw = section.gateway;
  if (!gw || gw.spawnRequestedAt === undefined || gw.readyObservedAt === undefined) {
    return null;
  }
  return {
    startMs: gw.spawnRequestedAt - section.wallStartMs,
    spawnedMs: gw.spawnedAt !== undefined ? gw.spawnedAt - section.wallStartMs : null,
    endMs: gw.readyObservedAt - section.wallStartMs,
  };
}

// Signed offset on the boot axis, for the detail strip.
function offset(ms: number): string {
  return ms < 0 ? `−${formatDuration(-ms)}` : `+${formatDuration(ms)}`;
}

/**
 * The boot section rendered as a self-contained Gantt card: one lane per boot
 * phase (bars = the profiler spans of that phase), with a gateway-wait strip
 * above them when the gateway reported one, and the phase-boundary memory
 * checkpoints as a label row below. Renders on its OWN clock axis (0 = process
 * start, wallStartMs), never the trace window's — the boot happened minutes
 * before the monitor's trip instant, so window-relative positions would be
 * meaningless (the engine clock-domain rule). Bar clicks report span/gateway
 * detail up to the pane's shared bottom strip via `onSelect`.
 */
export function BootLane({ payload, onSelect }: TraceLaneProps): ReactElement {
  const parsed = BootSectionSchema.safeParse(payload);
  if (!parsed.success) {
    return (
      <Stack gap="xs" className="border-b px-lg py-sm">
        <SectionLabel>Server boot</SectionLabel>
        <Placeholder tone="muted">No boot profile recorded for this trace.</Placeholder>
      </Stack>
    );
  }
  const section = parsed.data;
  const { totalDurationMs, spans, memoryCheckpoints, gateway } = section;

  const gw = gatewayWindow(section);
  // The gateway wait starts BEFORE process start (negative offset) and may end
  // after the last span — shift the whole axis so every bar lands on-track.
  const originMs = Math.min(0, gw?.startMs ?? 0);
  const totalMs = Math.max(1, Math.max(totalDurationMs, gw?.endMs ?? 0) - originMs);

  // Group spans by phase in chronological (first-start) order.
  const byPhase = new Map<string, BootSpan[]>();
  for (const span of [...spans].sort((a, b) => a.startMs - b.startMs)) {
    const list = byPhase.get(span.phase) ?? [];
    list.push(span);
    byPhase.set(span.phase, list);
  }
  const spanById = new Map(spans.map((s) => [s.id, s]));

  const selectSpan = (id: string): void => {
    const span = spanById.get(id);
    if (span) onSelect?.(spanSelection(span));
  };

  return (
    // This card hosts its OWN GanttContainer inside the pane's window-axis one.
    // Stop pointerdown here so a drag-zoom on this card's track never also
    // captures (and zooms) the outer window Gantt — the two axes are unrelated.
    <div className="border-b" onPointerDown={(e) => e.stopPropagation()}>
      <Stack direction="row" align="center" gap="sm" className="px-lg py-xs">
        <SectionLabel>Server boot</SectionLabel>
        <Badge variant="muted" mono>
          boot {formatDuration(totalDurationMs)}
        </Badge>
        {gw && (
          <Badge variant="muted" mono>
            gateway wait {formatDuration(gw.endMs - gw.startMs)}
          </Badge>
        )}
      </Stack>

      <GanttContainer title="Boot" totalMs={totalMs}>
        <Stack gap="2xs" className="px-lg pb-sm">
          {gw && gateway && (
            <MultiSpanLane
              label="gateway"
              duration={formatDuration(gw.endMs - gw.startMs)}
              bars={gatewayBars(gw, originMs)}
              onBarClick={() => onSelect?.(gatewaySelection(gateway, gw))}
            />
          )}
          {[...byPhase.entries()].map(([phase, phaseSpans]) => (
            <MultiSpanLane
              key={phase}
              label={phase}
              duration={formatDuration(phaseExtentMs(phaseSpans))}
              bars={phaseSpans.map(
                (s): SpanBar => ({
                  id: s.id,
                  startMs: s.startMs - originMs,
                  durationMs: s.durationMs,
                  colorClass: phaseColorClass(phase),
                }),
              )}
              onBarClick={selectSpan}
            />
          ))}
        </Stack>
      </GanttContainer>

      {memoryCheckpoints.length > 0 && (
        <Stack gap="2xs" className="px-lg pb-sm">
          <Text as="div" variant="caption" tone="muted">
            Memory checkpoints
          </Text>
          <Cluster gap="xs">
            {memoryCheckpoints.map((c) => (
              <Badge key={`${c.label}:${c.atMs}`} variant="muted" mono>
                {checkpointLabel(c)}
              </Badge>
            ))}
          </Cluster>
        </Stack>
      )}
    </div>
  );
}

function phaseExtentMs(phaseSpans: BootSpan[]): number {
  const start = Math.min(...phaseSpans.map((s) => s.startMs));
  const end = Math.max(...phaseSpans.map((s) => s.startMs + s.durationMs));
  return end - start;
}

// spawn-request → spawned as the dimmed leading segment, spawned → ready as the
// solid one; a single bar when the gateway didn't report spawnedAt.
function gatewayBars(gw: GatewayWindow, originMs: number): SpanBar[] {
  if (gw.spawnedMs === null) {
    return [
      {
        id: "gateway:wait",
        startMs: gw.startMs - originMs,
        durationMs: gw.endMs - gw.startMs,
        colorClass: "bg-info",
      },
    ];
  }
  return [
    {
      id: "gateway:spawn",
      startMs: gw.startMs - originMs,
      durationMs: gw.spawnedMs - gw.startMs,
      colorClass: "bg-info/40",
    },
    {
      id: "gateway:ready-wait",
      startMs: gw.spawnedMs - originMs,
      durationMs: gw.endMs - gw.spawnedMs,
      colorClass: "bg-info",
    },
  ];
}

function checkpointLabel(c: BootMemoryCheckpoint): string {
  return `${c.label} +${formatDuration(c.atMs)} · ${c.physFootprintMb} MB phys · ${c.heapUsedMb} MB heap`;
}

function spanSelection(span: BootSpan): TraceSelection {
  const fields: TraceSelection["fields"] = [
    { label: "phase", value: span.phase },
    { label: "start", value: offset(span.startMs) },
    { label: "duration", value: formatDuration(span.durationMs) },
  ];
  if (span.plugin) fields.push({ label: "plugin", value: span.plugin });
  if (span.physFootprintStartMb !== undefined && span.physFootprintEndMb !== undefined) {
    fields.push({
      label: "phys footprint",
      value: `${span.physFootprintStartMb} MB → ${span.physFootprintEndMb} MB`,
    });
  }
  return { title: span.label === span.id ? span.id : `${span.id} — ${span.label}`, fields };
}

function gatewaySelection(gw: BootGateway, w: GatewayWindow): TraceSelection {
  const fields: TraceSelection["fields"] = [
    { label: "spawn requested", value: offset(w.startMs) },
  ];
  if (w.spawnedMs !== null) {
    fields.push({
      label: "spawned",
      value: `${offset(w.spawnedMs)} (${formatDuration(w.spawnedMs - w.startMs)} after request)`,
    });
  }
  fields.push({
    label: "ready observed",
    value: `${offset(w.endMs)} (${formatDuration(w.endMs - w.startMs)} total wait)`,
  });
  const flags = [
    gw.escalated === true ? "escalated" : null,
    gw.respondedHTTP === true ? "responded over HTTP" : null,
    gw.demoted === true ? "demoted" : null,
  ].filter((f) => f !== null);
  if (flags.length > 0) fields.push({ label: "flags", value: flags.join(" · ") });
  return { title: "gateway readiness wait", fields };
}
