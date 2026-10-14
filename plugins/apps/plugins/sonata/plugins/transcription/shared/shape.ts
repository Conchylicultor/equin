import { nullable } from "@plugins/fields/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { songsEntityRef } from "@plugins/apps/plugins/sonata/plugins/library/core";
import { TRANSCRIPTION_STATUSES } from "../core";
import { TranscriptionInputSchema } from "./input";

/**
 * A song's transcription, stored in the `sonata_songs_ext_transcription`
 * entity-extension table (1:1 with `sonata_songs`, FK CASCADE on song delete),
 * which `server/internal/tables.ts` builds from this shape. A row exists only
 * for a song created by "Transcribe…"; the score itself, once submitted, is the
 * MusicXML source's.
 *
 * It EXPOSES the run state to every list of songs: `status` (the card badge and
 * the "Transcribing" filter, run on the server), and the latest conversation and
 * error the player's pending body reads off the song's row. A song nobody
 * transcribed has no row and reads all three as null.
 */
export const songTranscriptionShape = defineExtensionShape({
  key: "songId",
  fields: {
    status: enumTextField(TRANSCRIPTION_STATUSES),
    // What was asked for — a retry relaunches it. The `default` is only the
    // field's wire default; every insert names its input.
    input: jsonField({
      schema: TranscriptionInputSchema,
      default: { kind: "url", url: "https://example.invalid/" },
    }),
    // The task the transcription runs under (a retry adds an attempt to it).
    taskId: textField(),
    // The latest conversation transcribing it: what "Open conversation"
    // opens. Null only between the row's insert and the launch.
    conversationId: nullable(textField()),
    // Why the latest run failed; null unless `status` is `failed`.
    error: nullable(textField()),
  },
  serverOnly: ["input", "taskId"],
  exposes: {
    parent: songsEntityRef,
    name: "transcription",
    fields: {
      status: {
        label: "Transcription",
        options: {
          transcribing: { label: "Transcribing", variant: "info" },
          failed: { label: "Transcription failed", variant: "destructive" },
          ready: { label: "Transcribed", quiet: true },
          null: { label: "Not transcribed", quiet: true },
        },
      },
      conversationId: { label: "Transcription conversation" },
      error: { label: "Transcription error" },
    },
  },
});
