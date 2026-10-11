import { useState } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { SourceLine } from "@plugins/apps/plugins/sonata/plugins/primitives/plugins/source-line/web";
import { RecordingVideo } from "@plugins/apps/plugins/sonata/plugins/recording/web";
import type { AlignmentCandidate, UgAlignmentRow } from "../../core";
import {
  candidateTitle,
  percent,
  recordingState,
  recordingVideoId,
  type RecordingState,
} from "../internal/recording-state";
import { useUgAlignment } from "../internal/use-ug-raw";
import { AlignmentStatus } from "./alignment-status";
import { ChipBadge, outcomeChip, type Chip } from "./outcome-chip";
import { VideoReplace } from "./video-replace";

/** The state, for a section the `useAvailable` gate guarantees is a UG song. */
function useRecordingState(): {
  songId: string;
  state: RecordingState;
  /** The row once read (null: the song has none yet); the candidates and the pick live there. */
  row: UgAlignmentRow | null;
  /** The video on screen (`recordingVideoId`): the one the session's recording plays. */
  shownVideoId: string | null;
} {
  const { songId, raw, row } = useUgAlignment();
  if (raw === undefined || songId === null) {
    throw new Error(
      "The Recording section rendered without an open Ultimate Guitar song — its useAvailable gate should prevent this.",
    );
  }
  const found = row.status === "ready" && row.found ? row.row : null;
  return {
    songId,
    state: recordingState(row, raw.tab),
    row: found,
    shownVideoId: recordingVideoId(raw, row),
  };
}

/**
 * The video the source line names: the state's own (the chosen video), else
 * the candidate the resolver is trying, else the one on screen (the resolver's
 * best weak try, for a song that needs a video).
 */
function lineVideoId(
  state: RecordingState,
  row: UgAlignmentRow | null,
  shownVideoId: string | null,
): string | null {
  switch (state.kind) {
    case "loading":
    case "unreadable":
      return null;
    case "working":
    case "failed":
    case "cancelled":
      if (state.videoId !== null) return state.videoId;
      break;
    case "aligned":
    case "weak":
    case "out-of-date":
      return state.videoId;
    case "no-video":
    case "needs-video":
      break;
  }
  const trying = row?.candidates.find((c) => c.outcome === "trying");
  return trying?.videoId ?? shownVideoId;
}

/** The line's match chip: how the alignment to this video stands. */
function lineChip(
  state: RecordingState,
  videoId: string,
  candidate: AlignmentCandidate | undefined,
): Chip | null {
  switch (state.kind) {
    case "working":
      if (state.videoId === videoId) {
        return { variant: "primary", label: "Aligning" };
      }
      break;
    case "aligned":
      return { variant: "success", label: percent(state.score) };
    case "weak":
      return { variant: "warning", label: `Weak ${percent(state.score)}` };
    case "failed":
      if (state.videoId === videoId) {
        return { variant: "destructive", label: "Failed" };
      }
      break;
    case "out-of-date":
      return { variant: "muted", label: "Out of date" };
    case "loading":
    case "unreadable":
    case "no-video":
    case "needs-video":
    case "cancelled":
      break;
  }
  return candidate === undefined ? null : outcomeChip(candidate);
}

/**
 * The song's recording (`Sonata.Section`, area `editor`): the video itself
 * (`RecordingVideo` with its volume — a viewport onto the session's recording
 * player, synced to the transport when the score plays on it, else playing on
 * its own), then where the alignment stands
 * (`AlignmentStatus`), the video's line (title with its match chip, channel,
 * Replace) and, when Replace is open, the picker inline below it. All of it is
 * derived from the live row (`recordingState`), so it follows a job running in
 * the background; applying the result to the Score is the `UgAlignmentSync`
 * effect's job, and declaring the video the `UgRecordingVideo` effect's, not
 * this body's: it unmounts when collapsed, and the video plays on unseen.
 */
export function RecordingSection() {
  const { songId, state, row, shownVideoId } = useRecordingState();
  const [replacing, setReplacing] = useState(false);
  const videoId = lineVideoId(state, row, shownVideoId);
  const candidate =
    videoId === null
      ? undefined
      : row?.candidates.find((c) => c.videoId === videoId);
  const stateChip =
    videoId === null ? null : lineChip(state, videoId, candidate);
  // Who chose it goes in the chip's tooltip (unless the chip has its own).
  const chip =
    stateChip !== null &&
    stateChip.title === undefined &&
    row !== null &&
    row.videoId === videoId
      ? {
          ...stateChip,
          title: row.pick === "auto" ? "Picked automatically" : "Set by you",
        }
      : stateChip;

  return (
    <Stack gap="md">
      {/* The viewport onto the session's player (the video is declared by
          `UgRecordingVideo`, so it plays on while this section is collapsed). */}
      <RecordingVideo />

      <AlignmentStatus
        songId={songId}
        state={state}
        onReplace={() => setReplacing(true)}
      />

      {state.kind === "loading" || state.kind === "unreadable" ? null : (
        <SourceLine
          title={
            videoId === null ? "No video" : candidateTitle(candidate, videoId)
          }
          badge={chip === null ? undefined : <ChipBadge chip={chip} />}
          subtitle={candidate?.channel ?? undefined}
          action={
            <Button variant="ghost" onClick={() => setReplacing(!replacing)}>
              {replacing ? "Done" : videoId === null ? "Choose" : "Replace"}
            </Button>
          }
        >
          {replacing ? (
            <VideoReplace
              // A new chosen video resets the prefilled link.
              key={row?.videoId ?? ""}
              songId={songId}
              videoId={row?.videoId ?? null}
              candidates={row?.candidates ?? []}
              onDone={() => setReplacing(false)}
            />
          ) : null}
        </SourceLine>
      )}
    </Stack>
  );
}
