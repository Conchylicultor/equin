import { defineHint, defineHintAnchor } from "@plugins/hints/core";

/** The prompt's main action button (Push & Close / Close / Go / Send …). */
export const mainActionAnchor = defineHintAnchor("push-and-exit.main-action");

// One tip per state that is a decision to make once the agent's turn is over.
// Each is titled with the button's real label in that state. After the
// "Try it before it ships" tip (order 1): try the change, then decide.

export const pushAndCloseHint = defineHint({
  id: "push-and-exit.push-and-exit",
  anchor: mainActionAnchor,
  title: "Push & Close",
  body: "Happy with it? This ships the change to your equin and closes the conversation once it's live. Not quite right? Reply instead — the agent keeps going.",
  placement: "top",
  order: 2,
});

export const closeHint = defineHint({
  id: "push-and-exit.exit",
  anchor: mainActionAnchor,
  title: "Close",
  body: "Nothing to ship here. A conversation stays in your queue until you close it — so nothing you launch gets lost.",
  placement: "top",
  order: 2,
});

export const goHint = defineHint({
  id: "push-and-exit.go",
  anchor: mainActionAnchor,
  title: "Go",
  body: "The agent wrote a plan first. Read it, then let it build — or reply to change the plan.",
  placement: "top",
  order: 2,
});
