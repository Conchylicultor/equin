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
  const branch = new BranchForest();
  for (const line of lines) branch.add(line);
  return branch.kept();
}

/**
 * The branch filter kept up to date a line at a time: `add` each line in file
 * order and `isDropped` answers what `activeLineUuids` would over every line
 * added so far — so an append costs its own lines (plus the subtree a rewind
 * drops), never the whole forest.
 *
 * A line only ever goes from kept to dropped (a later prompt sibling rewinds
 * an earlier one, never the reverse), and `add` returns the uuids it dropped:
 * a reader that already used a line it now drops knows its earlier answer is
 * stale.
 */
export class BranchForest {
  private readonly uuids: string[] = [];
  private readonly children = new Map<string, string[]>();
  private readonly promptChildren = new Map<string, string[]>();
  private readonly dropped = new Set<string>();

  /** Add the next line in file order; returns the uuids this line dropped (itself included). */
  add(line: Record<string, unknown>): readonly string[] {
    const uuid = typeof line.uuid === "string" ? line.uuid : null;
    if (!uuid) return [];
    this.uuids.push(uuid);
    const parent = typeof line.parentUuid === "string" ? line.parentUuid : null;
    if (!parent) return [];
    const siblings = this.children.get(parent);
    if (siblings) siblings.push(uuid);
    else this.children.set(parent, [uuid]);
    const roots: string[] = [];
    // Under a dropped parent: in its subtree, so dropped as well.
    if (this.dropped.has(parent)) roots.push(uuid);
    if (userPromptText(line) !== null) {
      // Every prompt but the file-order-latest under one parent was rewound
      // away: this one supersedes the previous latest.
      const prompts = this.promptChildren.get(parent);
      if (prompts) {
        roots.push(prompts[prompts.length - 1]!);
        prompts.push(uuid);
      } else this.promptChildren.set(parent, [uuid]);
    }
    return roots.length > 0 ? this.drop(roots) : [];
  }

  /** Whether the line `uuid` is on a rewound branch. */
  isDropped(uuid: string): boolean {
    return this.dropped.has(uuid);
  }

  /** Every uuid added that is not on a rewound branch. */
  kept(): Set<string> {
    const kept = new Set<string>();
    for (const uuid of this.uuids) if (!this.dropped.has(uuid)) kept.add(uuid);
    return kept;
  }

  // Drop each root's subtree. The dropped set is also the guard against a
  // malformed cyclic chain.
  private drop(stack: string[]): string[] {
    const newly: string[] = [];
    while (stack.length > 0) {
      const uuid = stack.pop()!;
      if (this.dropped.has(uuid)) continue;
      this.dropped.add(uuid);
      newly.push(uuid);
      const kids = this.children.get(uuid);
      if (kids) stack.push(...kids);
    }
    return newly;
  }
}
