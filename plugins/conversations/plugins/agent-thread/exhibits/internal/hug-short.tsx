import { ThreadExhibit } from "./thread-exhibit";
import { FAILED } from "./fixtures";

/** Hugging a short thread: the frame is as tall as header + turn + composer. */
export default function HugShortThreadExhibit() {
  return <ThreadExhibit fixture={FAILED} height="hug" />;
}
