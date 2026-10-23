import { defineHint, defineHintAnchor } from "@plugins/hints/core";

/** The conversation action bar's rocket — the Open app button. */
export const openAppAnchor = defineHintAnchor("open-app.button");

/**
 * Shown once the agent's build has succeeded and its turn is over: the moment
 * there is something to try. Before the main-button tip (order 2) — try it,
 * then decide.
 */
export const tryItHint = defineHint({
  id: "open-app.try-it",
  anchor: openAppAnchor,
  title: "Try it before it ships",
  body: "The agent built this on its own copy of equin. Open it to try the change for real — nothing reaches your equin until you push.",
  placement: "bottom",
  order: 1,
});
