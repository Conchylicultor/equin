import type { YouTubePlayerState } from "@plugins/integrations/plugins/youtube/web";
import { statusFromPlayerCode } from "@plugins/integrations/plugins/youtube/core";
import type { MediaRefusal } from "../refusal";

/** What a player error says, for the video it was showing. */
export type PlayerFault =
  /** YouTube refused the video: it is gone, or not embeddable. Reported to whoever chose it. */
  | { kind: "refused"; refusal: MediaRefusal }
  /** The player failed for a reason that says nothing about the video (an invalid parameter, an HTML5 fault). Shown, never reported; a reload may clear it. */
  | { kind: "player"; code: number };

export function faultOf(
  state: YouTubePlayerState,
  videoId: string,
): PlayerFault | null {
  if (state.kind !== "error" || state.videoId !== videoId) return null;
  const verdict = statusFromPlayerCode(state.code);
  if (verdict.kind === "decided" && verdict.status !== "ok") {
    return {
      kind: "refused",
      refusal: {
        provider: "youtube",
        videoId,
        status: verdict.status,
        code: state.code,
      },
    };
  }
  return { kind: "player", code: state.code };
}
