import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { LiveColumns } from "@plugins/network/plugins/live/server";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { conversationStatusChanged } from "@plugins/tasks/plugins/tasks-core/server";
import { TaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { ScratchProfile } from "@plugins/conversations/plugins/workspace/server";
import {
  getSongTranscription,
  retryTranscription,
  prepareTranscription,
} from "../shared/endpoints";
import {
  handleGetSongTranscription,
  handleRetryTranscription,
  handlePrepareTranscription,
} from "./internal/routes";
import { transcriptionProfile } from "./internal/profile";
import { submitTranscriptionTool } from "./internal/mcp-tool";
import { transcriptionConversationStatusJob } from "./internal/conversation-status";
import { SONATA_CATEGORY_ID } from "./internal/launch";
import { songTranscription } from "./internal/tables";

export default {
  description:
    "Owns the sonata_songs_ext_transcription side-table: a transcribed song's run state (status, input, task, latest conversation, error). POST transcribe creates the song (MusicXML source), a Sonata task and a transcribing agent in a `sonata.transcription` scratch workspace (CLAUDE.md = the instructions, ./bin/st = the toolkit); its sonata_submit_transcription MCP tool imports the agent's MusicXML into the song. Exposes its status, latest conversation and error to every list of songs (LiveColumns.Expose); a conversation closed before submitting marks the song failed (retry relaunches).",
  httpRoutes: {
    [prepareTranscription.route]: handlePrepareTranscription,
    [retryTranscription.route]: handleRetryTranscription,
    [getSongTranscription.route]: handleGetSongTranscription,
  },
  contributions: [
    LiveColumns.Expose(songTranscription),
    TaskCategory({ id: SONATA_CATEGORY_ID, label: "Sonata", order: 13 }),
    Trigger({
      on: conversationStatusChanged,
      do: transcriptionConversationStatusJob,
      with: {},
      oneShot: false,
    }),
  ],
  register: [
    transcriptionConversationStatusJob,
    ScratchProfile.define(transcriptionProfile),
    submitTranscriptionTool,
  ],
} satisfies ServerPluginDefinition;
