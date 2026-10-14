import { useEffect } from "react";
import { useSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import { useConfig } from "@plugins/config_v2/web";
import { loopConfig } from "../../shared/config";

/**
 * Headless (a `Sonata.Effect`): pushes the user's loop preferences
 * (`loopConfig`, edited from the Loop control's options menu) into the
 * playback session, which owns what they mean — `rest` makes every repeat
 * open with a bar of rest (real time for the cursor, the audio and the
 * metronome), `ahead` makes the piano roll draw the loop repeating past B.
 */
export function LoopOptionsSync() {
  const { showAhead, restBeforeRepeat } = useConfig(loopConfig);
  const { setLoopOptions } = useSession();
  useEffect(() => {
    setLoopOptions({ rest: restBeforeRepeat, ahead: showAhead });
  }, [setLoopOptions, restBeforeRepeat, showAhead]);
  return null;
}
