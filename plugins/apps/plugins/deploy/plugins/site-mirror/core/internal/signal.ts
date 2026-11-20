import { z } from "zod";

/**
 * The box-link signal source the box half raises (`BoxSignal`) and the pull
 * half answers (`onBoxSignal`): "a mirror set's source log advanced on the
 * box". A doorbell, never data — the pull reads what changed.
 */
export const MIRROR_BOX_SIGNAL_SOURCE = "table-mirror";

/** The signal's payload: which set advanced. */
export const MirrorBoxSignalSchema = z.object({ setId: z.string() });
export type MirrorBoxSignal = z.infer<typeof MirrorBoxSignalSchema>;

/**
 * At most one ring per set per this many ms on the box: a busy site's
 * beacons advance the analytics log several times a second.
 */
export const MIRROR_SIGNAL_THROTTLE_MS = 2_000;
