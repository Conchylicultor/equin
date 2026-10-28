import {
  Trigger,
  type EventSource,
} from "@plugins/infra/plugins/events/server";
import type { WatchEventInput } from "../../core";
import { WatchSource } from "../../server/internal/contributions";
import { watchIngestJob } from "./jobs";

/**
 * Declare a watch source: what one event (`on`) means to a watcher. Returns
 * the source AND the trigger that feeds it — spread both into `contributions`
 * (`...watchSource({ … })`), so a source can never be declared unfed.
 *
 * `toEvents` gets the payload as emitted (it reached the ingest job as JSON);
 * an empty array means "nothing a watcher hears".
 */
export function watchSource<P extends Record<string, unknown>>(spec: {
  id: string;
  on: EventSource<P>;
  toEvents: (payload: P) => WatchEventInput[] | Promise<WatchEventInput[]>;
}) {
  return [
    WatchSource({
      id: spec.id,
      // The ingest job hands back exactly the payload `on` emitted.
      toEvents: (payload) => spec.toEvents(payload as P),
    }),
    Trigger({
      on: spec.on,
      do: watchIngestJob,
      with: { source: spec.id },
      oneShot: false,
    }),
  ] as const;
}
