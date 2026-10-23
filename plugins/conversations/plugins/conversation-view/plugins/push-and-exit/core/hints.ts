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
  body: "Looks good? Ship it to your equin and mark the conversation as complete. Want changes instead? Just reply — the agent keeps going.",
  placement: "top",
  order: 2,
});

/** Close after the change landed — not the side-chat Close (`exit-sibling`), which has no tip. */
export const closeHint = defineHint({
  id: "push-and-exit.exit",
  anchor: mainActionAnchor,
  title: "Close",
  body: "Changes have been pushed to your equin. Close the conversation to mark it complete.",
  placement: "top",
  order: 2,
});

export const goHint = defineHint({
  id: "push-and-exit.go",
  anchor: mainActionAnchor,
  title: "Go",
  body: "The agent proposed a plan. Click Go to let it build — or reply to change the plan first.",
  placement: "top",
  order: 2,
});

export const dropAndCloseHint = defineHint({
  id: "push-and-exit.drop-and-exit",
  anchor: mainActionAnchor,
  title: "Drop & Close",
  body: "To keep your queue clean, drop a conversation once the agent has given you all the answers you need. Want to build something instead? Just reply to continue the conversation.",
  placement: "top",
  order: 2,
});
