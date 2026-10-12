import { implement } from "@plugins/infra/plugins/endpoints/server";
import { setRhythmEndpoint } from "../../shared/endpoints";
import { songRhythm } from "./tables";

export const handleSetRhythm = implement(
  setRhythmEndpoint,
  async ({ params, body }) => {
    // Upsert the per-song groove. The FK to sonata_songs makes a write for a
    // non-existent song fail loudly.
    await songRhythm.upsert(params.id, {
      enabled: body.enabled,
      bass: body.bass,
      chord: body.chord,
      bassPatternId: body.bassPatternId,
      chordPatternId: body.chordPatternId,
      bassVoicing: body.bassVoicing,
      chordVoicing: body.chordVoicing,
      groovePresetId: body.groovePresetId,
    });
  },
);
