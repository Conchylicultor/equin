import { z } from "zod";
import { Mcp } from "@plugins/infra/plugins/mcp/server";
import { workspaceOfConversation } from "@plugins/conversations/plugins/workspace/server";
import { recordScratchDelivery } from "@plugins/tasks/plugins/tasks-core/server";
import {
  importMusicXmlForSong,
  MusicXmlParseError,
} from "@plugins/apps/plugins/sonata/plugins/sources/plugins/musicxml/server";
import { songAttachments } from "@plugins/apps/plugins/sonata/plugins/library/server";
import type { SongId } from "@plugins/apps/plugins/sonata/plugins/library/core";
import { SUBMIT_TOOL, TRANSCRIPTION_PROFILE_ID } from "./profile-input";
import { submitTranscription } from "./submit";
import { markReady } from "./state";
import { songTranscription } from "./tables";

/**
 * Ready, with the uploads relinked: the import links the song to its score
 * alone (`songAttachments.set`), and the uploads it was transcribed from stay
 * the song's.
 */
async function markReadyKeepingInputs(songId: SongId): Promise<void> {
  const row = await songTranscription.get(songId);
  if (!row)
    throw new Error(`[transcription] no transcription row for ${songId}`);
  if (row.input.kind === "files") {
    await songAttachments.add(songId, row.input.attachmentIds);
  }
  await markReady(songId);
}

export const submitTranscriptionTool = Mcp.tool({
  name: SUBMIT_TOOL,
  profiles: [TRANSCRIPTION_PROFILE_ID],
  description: `Submit your finished MusicXML transcription: it becomes the song's score in Sonata. Call it once the render matches the source bar by bar.

If the document cannot be imported, the error names the element and measure at fault and nothing is saved: fix the file, render it again, and submit again. Once it succeeds, write a short summary and call \`exit_clean\`.`,
  inputSchema: {
    path: z
      .string()
      .min(1)
      .describe(
        'The MusicXML file, relative to your working directory (e.g. "score.musicxml").',
      ),
  },
  async handler({ path }, { conversationId }) {
    const { file } = await submitTranscription(
      { conversationId, path },
      {
        workspaceOf: workspaceOfConversation,
        importMusicXml: importMusicXmlForSong,
        isParseError: (err): err is Error => err instanceof MusicXmlParseError,
        markReady: markReadyKeepingInputs,
        recordDelivery: (id, summary) => recordScratchDelivery(id, { summary }),
      },
    );
    return {
      content: [
        {
          type: "text",
          text: `Imported ${file}: it is the song's score now, and the task is delivered. Write a two-line summary (what you transcribed, any bar you were unsure of), then call exit_clean.`,
        },
      ],
    };
  },
});
