import { describe, expect, it } from "vitest";
import type { BlockHandle } from "../../core";
import type { InsertAction } from "../types";
import {
  flattenEntries,
  withInsertActions,
  type BlockSection,
  type InsertEntry,
} from "../internal/block-sections";
import { filterInsertEntries } from "../components/block-type-list";
import { symbol } from "@plugins/ui/plugins/icons/core";

const testIcon = symbol("add");

// `Editor.InsertAction`s placed among the block types, and ranked against them
// by the `/` query. The menu itself is `BlockMenuPlugin`; what is pinned here is
// the two pure halves it reads: WHERE an action is listed, and HOW it ranks.

function handle(
  type: string,
  label: string,
  aliases?: string[],
): BlockHandle<unknown> {
  return { type, label, aliases } as unknown as BlockHandle<unknown>;
}

function action(
  id: string,
  label: string,
  over: Partial<InsertAction> = {},
): InsertAction {
  return { id, label, icon: testIcon, useRun: () => () => {}, ...over };
}

/** Compact view: one string per row, sections separated. */
function shape(sections: { label?: string; entries: InsertEntry[] }[]) {
  return sections.map((s) => ({
    label: s.label,
    rows: s.entries.map((e) =>
      e.kind === "block" ? e.block.type : `action:${e.action.id}`,
    ),
  }));
}

const grouped: BlockSection[] = [
  { label: "Basic blocks", blocks: [handle("text", "Text")] },
  {
    label: "Annotations",
    blocks: [
      handle("context", "Human notes"),
      handle("agent-note", "Agent notes", ["agent-notes"]),
      handle("private-note", "Private notes"),
    ],
  },
];

describe("withInsertActions", () => {
  it("lists an action right after the block type its `after` names, in that type's section", () => {
    const out = withInsertActions(grouped, [
      action("agent-page", "Agent page", { after: "agent-note" }),
    ]);
    expect(shape(out)).toEqual([
      { label: "Basic blocks", rows: ["text"] },
      {
        label: "Annotations",
        rows: ["context", "agent-note", "action:agent-page", "private-note"],
      },
    ]);
  });

  it("keeps contribution order when several actions follow one type", () => {
    const out = withInsertActions(grouped, [
      action("a", "A", { after: "text" }),
      action("b", "B", { after: "text" }),
    ]);
    expect(shape(out)[0]!.rows).toEqual(["text", "action:a", "action:b"]);
  });

  it("gives an action with no placeable `after` a trailing section — never drops it", () => {
    const out = withInsertActions(grouped, [
      action("loose", "Loose"),
      // A type that is not offered here (renamed, unregistered, allowlisted
      // out) must move the action, not hide it.
      action("orphan", "Orphan", { after: "no-such-type" }),
    ]);
    expect(shape(out).at(-1)).toEqual({
      label: undefined,
      rows: ["action:loose", "action:orphan"],
    });
  });

  it("is the block sections unchanged when there are no actions", () => {
    expect(shape(withInsertActions(grouped, []))).toEqual([
      { label: "Basic blocks", rows: ["text"] },
      {
        label: "Annotations",
        rows: ["context", "agent-note", "private-note"],
      },
    ]);
  });
});

describe("filterInsertEntries", () => {
  const flat = flattenEntries(
    withInsertActions(grouped, [
      action("agent-page", "Agent page", {
        after: "agent-note",
        aliases: ["agent-page"],
      }),
    ]),
  );
  const rows = (q: string) =>
    filterInsertEntries(flat, q).map((e) =>
      e.kind === "block" ? e.block.type : `action:${e.action.id}`,
    );

  it("ranks an action among block types by the same rules", () => {
    // Both labels start with "agent" (tier 0), so list order breaks the tie.
    expect(rows("agent")).toEqual(["agent-note", "action:agent-page"]);
  });

  it("matches an action's own label and aliases", () => {
    expect(rows("page")).toEqual(["action:agent-page"]);
    expect(rows("agent-p")).toEqual(["action:agent-page"]);
  });

  it("returns every entry for an empty query", () => {
    expect(rows(" ")).toHaveLength(flat.length);
  });
});
