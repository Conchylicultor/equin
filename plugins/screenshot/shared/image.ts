import { liveValue } from "@plugins/network/plugins/live/core";

/**
 * A captured screenshot's PNG bytes, by the id the capturing tab minted. The
 * capturing tab opens the editor tab BEFORE it uploads, so the first read is
 * usually refused `missing`; the upload's write notifies the tuple and the
 * editor re-reads it — no poll.
 *
 * Refused:
 * - `missing` — nothing is stored under the id (not uploaded yet, expired
 *   after an hour, or lost to a server restart).
 */
export const screenshotImage = liveValue("screenshot.image", {
  bytes: true,
  params: ["id"],
  refusals: ["missing"],
});
