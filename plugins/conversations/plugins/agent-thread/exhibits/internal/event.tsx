import { ThreadExhibit } from "./thread-exhibit";
import { EVENT } from "./fixtures";

/** An event the app delivered opens a turn, drawn as the event card — not as the user's message. */
export default function EventThreadExhibit() {
  return <ThreadExhibit fixture={EVENT} />;
}
