import { ThreadExhibit } from "./thread-exhibit";
import { QUESTION } from "./fixtures";

/** The agent asked the user something and waits. */
export default function QuestionThreadExhibit() {
  return <ThreadExhibit fixture={QUESTION} />;
}
