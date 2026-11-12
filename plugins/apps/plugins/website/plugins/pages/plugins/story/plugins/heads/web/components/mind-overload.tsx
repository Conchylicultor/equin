import { mountMindOverload } from "../internal/mind-overload";
import { HeadFigureHost } from "./head-figure";

/**
 * A head full of agents: robots crowd in from behind, above and in front,
 * each pushing its conversation into the head, where the phrases jostle —
 * the newest loud — until an answer travels back out (a tick, and the agent
 * leaves; or a word it takes back to work). The head is never clear.
 */
export function MindOverload() {
  return <HeadFigureHost mount={mountMindOverload} />;
}
