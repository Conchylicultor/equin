import { mountReviewDesk } from "../internal/review-desk";
import { HeadFigureHost } from "./head-figure";

/**
 * One task at a time: ideas leave the head as agents that work in the
 * background, come back to wait in a line on the desk in front of it, and are
 * reviewed one at a time — closed with a tick, or sent back to work.
 */
export function ReviewDesk() {
  return <HeadFigureHost mount={mountReviewDesk} />;
}
