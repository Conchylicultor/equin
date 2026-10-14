import { serveColumns } from "@plugins/network/plugins/live/server";
import { transcriptionColumns } from "../../core";
import { songTranscription } from "./tables";

// The library's transcription columns, read through the transcription
// extension: LEFT, 1:1 on the song id (the server-only `input` / `taskId` are
// no wire columns, so they cannot be bound). A status write refills exactly
// that song.
export const transcriptionColumnsServed = serveColumns(transcriptionColumns, {
  join: songTranscription.join("transcription"),
});
