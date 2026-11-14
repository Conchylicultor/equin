import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import { serveValue } from "@plugins/network/plugins/live/server";
import type { SavedSymbolName } from "@plugins/ui/plugins/icons/core";
import { eventStreams, type EventStreamInfo } from "../../core";

/**
 * A stream of events supervisors can be sent: what it is called, its icon, a
 * line saying what it carries, and the kinds a route may narrow it to. The
 * stream's own plugin feeds it, through `publishSupervisorEvent`.
 */
export interface SupervisorEventStreamSpec {
  id: string;
  label: string;
  icon: SavedSymbolName;
  description: string;
  /** Every kind this stream's events can have (read once per process). */
  kinds(): readonly string[];
}

export const SupervisorEventStream =
  defineServerContribution<SupervisorEventStreamSpec>(
    "supervisor-event-stream",
    { docLabel: (s) => s.id },
  );

export function streamSpec(id: string): SupervisorEventStreamSpec | undefined {
  return SupervisorEventStream.getContributions().find((s) => s.id === id);
}

export function streamLabel(id: string): string {
  return streamSpec(id)?.label ?? id;
}

function streamInfos(): EventStreamInfo[] {
  return SupervisorEventStream.getContributions().map((s) => ({
    id: s.id,
    label: s.label,
    icon: s.icon,
    description: s.description,
    kinds: [...s.kinds()].sort(),
  }));
}

export const eventStreamsServed = serveValue(eventStreams, {
  source: "external",
  changes: {
    fixed: { reason: "the streams are contributions, fixed for the process" },
  },
  loader: streamInfos,
});
