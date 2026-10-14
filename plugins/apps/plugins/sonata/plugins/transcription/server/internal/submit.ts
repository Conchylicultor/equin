import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  songIdKind,
  type SongId,
} from "@plugins/apps/plugins/sonata/plugins/library/core";
import { ProfileInputSchema, TRANSCRIPTION_PROFILE_ID } from "./profile-input";
import { resolveWorkspaceFile } from "./workspace-file";

/** What the submit flow needs from the rest of the server — injected, so it is testable without a database. */
export interface SubmitDeps {
  /** The conversation's workspace: its directory and launch spec. */
  workspaceOf: (conversationId: string) => Promise<{
    path: string;
    spec: { kind: string; profile?: string; input?: unknown };
  }>;
  /** Fill the song with the document; throws `isParseError` errors on a bad document, before writing. */
  importMusicXml: (args: {
    songId: string;
    xml: string;
    fileName: string;
  }) => Promise<void>;
  isParseError: (err: unknown) => err is Error;
  markReady: (songId: SongId) => Promise<void>;
  /** Record that the conversation delivered its work (its task derives done once it closes). */
  recordDelivery: (conversationId: string, summary: string) => Promise<void>;
}

/** A document the agent must fix: its message is the feedback the tool returns. */
export class TranscriptionRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionRejectedError";
  }
}

/**
 * Submit the transcribing agent's score: resolve `path` inside ITS workspace
 * (never outside), import the document into the song its workspace was
 * launched for, mark the transcription ready and record the delivery on the
 * conversation (what lets its task derive `done`). The song comes from the
 * launch spec, not from the agent, so a submission can only fill its own song.
 * A document the importer rejects throws {@link TranscriptionRejectedError}
 * naming the element and measure, with nothing written.
 */
export async function submitTranscription(
  { conversationId, path }: { conversationId: string; path: string },
  deps: SubmitDeps,
): Promise<{ songId: SongId; file: string }> {
  const ws = await deps.workspaceOf(conversationId);
  if (
    ws.spec.kind !== "scratch" ||
    ws.spec.profile !== TRANSCRIPTION_PROFILE_ID
  ) {
    throw new Error(
      `[transcription] conversation ${conversationId} is not a ${TRANSCRIPTION_PROFILE_ID} workspace`,
    );
  }
  const { songId } = ProfileInputSchema.parse(ws.spec.input);
  const file = await resolveWorkspaceFile(ws.path, path);
  const xml = await readFile(file, "utf8");
  try {
    await deps.importMusicXml({ songId, xml, fileName: basename(file) });
  } catch (err) {
    if (!deps.isParseError(err)) throw err;
    throw new TranscriptionRejectedError(
      `The score was not imported: ${err.message}. Fix it, render again, and resubmit.`,
    );
  }
  const id = songIdKind.key(songId);
  await deps.markReady(id);
  await deps.recordDelivery(
    conversationId,
    `Transcribed ${basename(file)} into song ${songId}.`,
  );
  return { songId: id, file };
}
