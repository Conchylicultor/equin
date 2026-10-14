import { basename, extname } from "node:path";
import { createConversation } from "@plugins/conversations/server";
import {
  DEFAULT_MODEL_CHOICE,
  assertChoiceLaunchable,
} from "@plugins/conversations/plugins/model-provider/core";
import { getModelCatalog } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";
import { assertClaudeCodeReady } from "@plugins/infra/plugins/claude-cli/plugins/availability/server";
import { getAttachment } from "@plugins/infra/plugins/attachments/server";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import type { SongId } from "@plugins/apps/plugins/sonata/plugins/library/core";
import type { TranscriptionInput } from "../../shared/input";
import { markFailed, markTranscribing } from "./state";
import { TRANSCRIPTION_PROFILE_ID, type ProfileInput } from "./profile-input";

/** The task category transcription tasks are filed under. */
export const SONATA_CATEGORY_ID = "sonata";

/** Who launches the transcribing agents (`spawnedBy`, task author). */
export const TRANSCRIPTION_AUTHOR = "sonata-transcription";

const PROMPT =
  "Transcribe the sheet music in your source into score.musicxml and submit it, following CLAUDE.md.";

/**
 * Refuse a launch this machine cannot run BEFORE anything is written: Claude
 * Code missing or signed out, or the default model not runnable here.
 */
export async function assertCanLaunch(): Promise<void> {
  await assertClaudeCodeReady();
  assertChoiceLaunchable(DEFAULT_MODEL_CHOICE, getModelCatalog());
}

/**
 * The profile's view of the user's input: a link as is, uploads with their
 * file names (what the agent's `input/` copies are named after). An unknown
 * attachment is the caller's error (400).
 */
export async function resolveProfileSource(
  input: TranscriptionInput,
): Promise<ProfileInput["source"]> {
  if (input.kind === "url") return input;
  const files = await Promise.all(
    input.attachmentIds.map(async (attachmentId) => {
      const att = await getAttachment(attachmentId);
      if (!att) {
        throw new HttpError(400, `Attachment not found: ${attachmentId}`);
      }
      return { attachmentId, name: att.filename };
    }),
  );
  return { kind: "files", files };
}

/**
 * The song's title until the agent's score names it: the link's site and path
 * (`instagram.com/p/Dd7oBnUua5Y`), or the first upload's name.
 */
export function placeholderTitle(source: ProfileInput["source"]): string {
  if (source.kind === "url") {
    const u = new URL(source.url);
    const host = u.hostname.replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}`;
  }
  const first = source.files[0];
  if (!first) throw new Error("[transcription] a files source has no file");
  return basename(first.name, extname(first.name));
}

/**
 * Launch a transcribing agent for `songId` under `taskId` — a new attempt in
 * a `sonata.transcription` scratch workspace — and record it on the song. A
 * launch that throws marks the song failed (so it offers a retry) and
 * rethrows.
 */
export async function launchTranscription(
  songId: SongId,
  taskId: string,
  source: ProfileInput["source"],
): Promise<string> {
  const input: ProfileInput = { songId, source };
  let conversationId: string;
  try {
    const conversation = await createConversation({
      taskId,
      prompt: PROMPT,
      model: DEFAULT_MODEL_CHOICE,
      spawnedBy: TRANSCRIPTION_AUTHOR,
      kind: "agent",
      workspace: { kind: "scratch", profile: TRANSCRIPTION_PROFILE_ID, input },
    });
    conversationId = conversation.id;
  } catch (err) {
    await markFailed(
      songId,
      `Could not start the transcription: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
  await markTranscribing(songId, conversationId);
  return conversationId;
}
