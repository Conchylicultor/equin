import { useMemo } from "react";
import type {
  FieldDef,
  FieldExtensionProps,
} from "@plugins/primitives/plugins/data-view/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import type { TaskListItem } from "@plugins/tasks/plugins/tasks-core/core";
import {
  DEFAULT_TASK_TRACK,
  TASK_TRACKS,
  TRACK_META,
  type StoredTaskTrack,
} from "../../core";
import { useStoredTracks } from "../hooks";
import { TrackBadge } from "./track-badge";

/** Where the field's own read of the stored tracks is. */
type TracksRead =
  | { kind: "pending" }
  | { kind: "known"; tracks: ReadonlyMap<string, StoredTaskTrack> }
  | { kind: "failed"; error: Error; refetch: () => Promise<void> };

const TRACK_OPTIONS = TASK_TRACKS.map((track) => ({
  value: track,
  label: TRACK_META[track].label,
  variant: TRACK_META[track].variant,
  hint: TRACK_META[track].hint,
}));

/**
 * Field extension contributed into the task list's `Tasks.Fields`: one `track`
 * enum field whose cell is the track badge, so every row shows its track, and
 * which the tasks DataView can group and filter by (`enum` + `value`).
 *
 * While the tracks are not known yet the field is `pending` — its cells draw
 * the loading block and a view grouped, sorted or filtered by it renders its
 * loading state (data-view) — never "main", which would be a claim about the
 * task that then reverses. A failed read with nothing held is its
 * `readError`; one over a held map keeps painting it. The set is
 * preloaded, so this is at most one round-trip.
 */
export function TrackField({ render }: FieldExtensionProps<TaskListItem>) {
  const stored = useStoredTracks();
  const fields = useMemo<FieldDef<TaskListItem>[]>(() => {
    const read = foldResource<typeof stored, TracksRead>(stored, {
      loading: () => ({ kind: "pending" }),
      error: (error, stale) =>
        stale !== undefined
          ? { kind: "known", tracks: stale }
          : { kind: "failed", error, refetch: stored.refetch },
      ready: (tracks) => ({ kind: "known", tracks }),
    });
    // `null` only while not known — never "main". A pending or failed field
    // draws its state in every cell (the cell below is not reached) and holds
    // any view laid out by it.
    const trackOf = (t: TaskListItem) =>
      read.kind === "known"
        ? (read.tracks.get(t.id) ?? DEFAULT_TASK_TRACK)
        : null;
    return [
      {
        id: "track",
        label: "Track",
        type: "enum",
        align: "end",
        options: TRACK_OPTIONS,
        value: trackOf,
        cell: (t) => {
          const track = trackOf(t);
          return track === null ? null : <TrackBadge track={track} />;
        },
        ...(read.kind === "pending" ? { pending: true } : {}),
        ...(read.kind === "failed"
          ? { readError: { error: read.error, refetch: read.refetch } }
          : {}),
        // A grouping/filter dimension, not searchable text: kept out of the
        // full-text search accessor, still in the Filter pill.
        filterable: false,
      },
    ];
  }, [stored]);
  return <>{render(fields)}</>;
}
