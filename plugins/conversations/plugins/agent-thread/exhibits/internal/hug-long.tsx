import { ThreadExhibit } from "./thread-exhibit";
import { DONE } from "./fixtures";

/** Hugging a long thread: it stops at the frame's max height and the turns scroll, the composer pinned. */
export default function HugLongThreadExhibit() {
  return <ThreadExhibit fixture={DONE} height="hug" />;
}
