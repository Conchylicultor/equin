import { userPromptText } from "./user-prompt";

// Claude Code transcripts are a forest, not a flat log. Every line carries a
// `uuid` and a `parentUuid`, and a node branches for two unrelated reasons:
//
//   - **Rewind / edit-last-turn.** The user resubmits a turn: Claude appends
//     the new prompt as a SIBLING of the old one (same parent) and leaves the
//     abandoned attempt — the old prompt and everything under it — in the file.
//   - **Side leaves.** A line hangs off a live node while the conversation
//     carries on from a sibling: each result of a parallel tool batch is a
//     child of its own `tool_use` line (the batch's lines chain one after the
//     other, and the turn continues from whichever result landed last), hook
//     attachments, an API-error text, a `turn_duration` after an interrupt.
//     These are live content.
//
// `activeLineUuids` returns every uuid-bearing line EXCEPT those on a rewound
// branch. A branch counts as rewound only on proof: a user prompt (as
// `userPromptText` — the rewind cut point's own predicate — defines it) with a
// later prompt sibling under the same parent. The superseded prompt's whole
// subtree is dropped; nothing else is.
//
// The default is deliberately "keep". An unknown side-leaf shape is shown
// rather than silently lost; an unknown rewind shape (one not starting at a
// prompt — none observed) would show as visibly duplicated content. The old
// rule — keep each tree's newest-leaf→root path — dropped every side leaf,
// which lost whole tool calls of every parallel batch.
//
// Disjoint trees (resume / compaction / a fresh session in a chain) need no
// special case: they are simply kept. Lines without a uuid (metadata markers
// like `permission-mode` / `ai-title`) are not in the forest and are not in the
// returned set; the caller keeps them untouched.

export function activeLineUuids(
  lines: readonly Record<string, unknown>[],
): Set<string> {
  const uuids: string[] = [];
  const children = new Map<string, string[]>();
  const promptChildren = new Map<string, string[]>();
  for (const line of lines) {
    const uuid = typeof line.uuid === "string" ? line.uuid : null;
    if (!uuid) continue;
    uuids.push(uuid);
    const parent = typeof line.parentUuid === "string" ? line.parentUuid : null;
    if (!parent) continue;
    const siblings = children.get(parent);
    if (siblings) siblings.push(uuid);
    else children.set(parent, [uuid]);
    if (userPromptText(line) !== null) {
      const prompts = promptChildren.get(parent);
      if (prompts) prompts.push(uuid);
      else promptChildren.set(parent, [uuid]);
    }
  }

  // Every prompt but the file-order-latest under one parent was rewound away.
  // Lines are pushed in file order, so the latest is the last entry.
  const rewound: string[] = [];
  for (const prompts of promptChildren.values()) {
    rewound.push(...prompts.slice(0, -1));
  }

  // Drop each rewound prompt's subtree. The visited set is also the guard
  // against a malformed cyclic chain.
  const dropped = new Set<string>();
  const stack = rewound;
  while (stack.length > 0) {
    const uuid = stack.pop()!;
    if (dropped.has(uuid)) continue;
    dropped.add(uuid);
    const kids = children.get(uuid);
    if (kids) stack.push(...kids);
  }

  const kept = new Set<string>();
  for (const uuid of uuids) if (!dropped.has(uuid)) kept.add(uuid);
  return kept;
}
