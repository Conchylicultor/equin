import { ThreadExhibit } from "./thread-exhibit";
import { RUNNING } from "./fixtures";

/** A second turn under way: its steps live, the first turn folded. */
export default function RunningThreadExhibit() {
  return <ThreadExhibit fixture={RUNNING} />;
}
