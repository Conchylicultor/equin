import { ThreadExhibit } from "./thread-exhibit";
import { DONE } from "./fixtures";

/** Two turns done: the old picks struck through, a refused result call red in the folded steps. */
export default function DoneThreadExhibit() {
  return <ThreadExhibit fixture={DONE} />;
}
