import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import type { SwingOverride } from "@plugins/apps/plugins/sonata/plugins/score/core";
import { setSwingEndpoint } from "../shared/endpoints";

// Fire-and-forget write: the UI never reads the response — the loaded song's
// setting is written optimistically (`useWriteSongSetting(swingSetting)`) and
// the `swings` row push reaffirms it. A genuine network failure still surfaces
// loudly as an unhandled rejection.
export function saveSwing(songId: string, override: SwingOverride): void {
  void fetchEndpoint(setSwingEndpoint, { id: songId }, { body: override });
}
