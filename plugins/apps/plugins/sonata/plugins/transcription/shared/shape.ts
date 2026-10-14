import { nullable } from "@plugins/fields/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { TRANSCRIPTION_STATUSES } from "../core";
import { TranscriptionInputSchema } from "./input";

/**
 * A song's transcription, stored in the `sonata_songs_ext_transcription`
 * entity-extension table (1:1 with `sonata_songs`, FK CASCADE on song delete),
 * which `server/internal/tables.ts` builds from this shape. A row exists only
 * for a song created by "Transcribe…"; the score itself, once submitted, is the
 * MusicXML source's.
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
});
