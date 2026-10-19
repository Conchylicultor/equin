import { ThreadExhibit } from "./thread-exhibit";
import { FAILED } from "./fixtures";

/** The agent died mid-turn: the erred and unreturned steps red, no answer. */
export default function FailedThreadExhibit() {
  return <ThreadExhibit fixture={FAILED} />;
}
