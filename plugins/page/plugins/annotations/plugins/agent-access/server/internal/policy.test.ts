import { beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { collectContributions } from "@plugins/framework/plugins/server-core/core";
import { Editor, type StoredBlock } from "@plugins/page/plugins/editor/server";
import {
  pageBlockHandle,
  type Block,
  type BlockUpdate,
} from "@plugins/page/plugins/editor/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { defineAnnotationBlock } from "@plugins/page/plugins/annotations/core";
import { textBlock } from "@plugins/page/plugins/text/core";
import { agentNotesBlock } from "@plugins/page/plugins/annotations/plugins/agent-notes/core";
import type { MarkdownApplyPlan } from "@plugins/page/plugins/markdown-apply/core";
import type { BlockScope } from "@plugins/page/plugins/markdown-apply/server";
import {
  assertAgentAddressable,
  assertAgentAuthored,
  assertAgentAuthoredPlan,
  inertEmptyParagraphs,
  redactHumanAudience,
} from "./policy";

/**
 * The policy rules, over a fixture forest and hand-built plans.
 *
 * The annotation handles are THROWAWAY, registered through the real
 * `defineAnnotationBlock` — the point being that nothing here names a concrete
 * plugin's type: the rules enumerate `audience === "human"` and `author` off the
 * registry, so a type invented in this file is treated exactly like `/private`
 * or `/human`. A test that seeded the real four would prove the rules work for
 * the four we have, which is the weaker claim.
 *
 * `agent-note` is the one exception, on both sides: its tag is what a refusal
 * tells an agent to mint, so the fixture uses the real handle. So is `page`: an
 * agent-authored page declares its author through its own data
 * (`pageBlockHandle`'s `authorFromData`), and that per-row answer is exactly
 * what the cases below it pin.
 *
 * The two throwaways cover the two cells that matter to the write rule. Only
 * `author` decides a boundary, so `zz-authored` — agent-audience, human-authored
 * — is the interesting one: an agent READS it and may not write it, which is the
 * `/human` and `/todo` cell and the reason `author` exists as a separate
 * question from `audience`.
 */
const privateish = defineAnnotationBlock({
  type: "zz-withheld",
  schema: z.object({}),
  audience: "human",
  author: "human",
  markdown: { tag: { body: "children" } },
});
const humanish = defineAnnotationBlock({
  type: "zz-authored",
  schema: z.object({}),
  audience: "agent",
  author: "human",
  markdown: { tag: { body: "children" } },
});

beforeEach(() => {
  collectContributions([
    {
      id: "agent-access-policy-fixture",
      contributions: [
        Editor.BlockData(privateish),
        Editor.BlockData(humanish),
        Editor.BlockData(textBlock),
        Editor.BlockData(agentNotesBlock),
        Editor.BlockData(pageBlockHandle),
      ],
    },
  ]);
});

/**
 * ```
 * page
 * ├── prose
 * ├── withheld            (audience: human, author: human)
 * │   └── secret
 * │       └── deeper
 * ├── shared              (audience: agent, author: human)
 * │   └── open
 * ├── notes               (agent-note)
 * │   ├── note-line
 * │   └── answer          (audience: agent, author: human — the hole in the
 * │       └── answer-line  agent's own card: it reads this and may not write it)
 * ├── tainted             (agent-note, holding a withheld card — the drag case)
 * │   └── smuggled        (audience: human)
 * └── outer-existing      (agent-note)
 *     └── inner-existing  (agent-note — nesting, which is a legal shape)
 * ```
 */
const PAGE = "page";
let rank = 0;
function row(id: string, parentId: string, type: string): StoredBlock {
  rank += 1;
  return { id, parentId, type, data: {}, rank: `a${rank}`, expanded: true };
}
/** A HUMAN's page row: `author` absent. */
const humanPageData = { title: "Test page", icon: null };
const scope: BlockScope = {
  pageId: PAGE,
  // Carried by the scope for the page-title banner (`markdown-apply`'s
  // `core/page-title.ts`); nothing this policy asserts on reads it.
  title: "Test page",
  // The page's own row: a human's page, so it opens nothing.
  pageRow: { id: PAGE, type: "page", data: humanPageData },
  rows: [
    row("prose", PAGE, "text"),
    row("withheld", PAGE, privateish.type),
    row("secret", "withheld", "text"),
    row("deeper", "secret", "text"),
    row("shared", PAGE, humanish.type),
    row("open", "shared", "text"),
    row("notes", PAGE, agentNotesBlock.type),
    row("note-line", "notes", "text"),
    row("answer", "notes", humanish.type),
    row("answer-line", "answer", "text"),
    row("tainted", PAGE, agentNotesBlock.type),
    row("smuggled", "tainted", privateish.type),
    row("outer-existing", PAGE, agentNotesBlock.type),
    row("inner-existing", "outer-existing", agentNotesBlock.type),
  ],
};

describe("redactHumanAudience (rule 1, the read filter)", () => {
  test("drops human-audience rows and nothing else", () => {
    const kept = redactHumanAudience(scope.rows).map((r) => r.id);
    expect(kept).not.toContain("withheld");
    expect(kept).not.toContain("smuggled");
    // The DESCENDANTS are still in the filtered array — pruning them is the
    // engine's walk, which never reaches a child whose parent is gone. A filter
    // that also removed them would be a second, drifting implementation of the
    // same rule.
    expect(kept).toContain("secret");
    expect(kept).toContain("prose");
    expect(kept).toContain("shared");
  });

  test("an agent-audience annotation is ordinary content to it — author is a SEPARATE axis", () => {
    // `answer` is human-AUTHORED and agent-audience. Redaction keys on audience
    // only, so the agent sees it in full; what it may not do is write it, which
    // is rule 3's business and nothing to do with this filter.
    const kept = redactHumanAudience(scope.rows).map((r) => r.id);
    expect(kept).toContain("open");
    expect(kept).toContain("answer");
    expect(kept).toContain("answer-line");
  });

  test("is generic in the row type — ONE function serves the read and the apply", () => {
    // `ReadBlockOptions.redact` and `ApplyBlockOptions.redact` want different row
    // types; a second copy typed for the write is exactly the drift that would
    // make an apply diff against a document nobody saw. Compiling against a row
    // shape that is not `StoredBlock` is the assertion.
    const lean: { id: string; type: string }[] = [
      { id: "a", type: "text" },
      { id: "b", type: privateish.type },
    ];
    expect(redactHumanAudience(lean).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("assertAgentAddressable (rule 1, the ancestor half)", () => {
  test("allows the page, ordinary prose, and an agent-audience card's contents", () => {
    for (const id of [PAGE, "prose", "shared", "open", "notes", "note-line"]) {
      expect(() => {
        assertAgentAddressable(scope, id);
      }).not.toThrow();
    }
  });

  test("allows a human-AUTHORED card and its contents — it is addressed TO an agent", () => {
    for (const id of ["answer", "answer-line"]) {
      expect(() => {
        assertAgentAddressable(scope, id);
      }).not.toThrow();
    }
  });

  test("refuses the withheld card itself", () => {
    expect(() => {
      assertAgentAddressable(scope, "withheld");
    }).toThrow(/withheld from agents/);
  });

  test("refuses a block INSIDE it, at any depth — the id is not a bypass", () => {
    // Without this, redaction answers the read: the walk starts at a root the
    // filter removed, so it reaches nothing and the empty document reads as
    // "this block has no content".
    for (const id of ["secret", "deeper"]) {
      expect(() => {
        assertAgentAddressable(scope, id);
      }).toThrow(/withheld from agents/);
    }
  });
});

describe("assertAgentAuthored (rule 2 — write_agent_note's door)", () => {
  test("accepts an agent-note card", () => {
    expect(() => {
      assertAgentAuthored(scope, "notes");
    }).not.toThrow();
  });

  test("refuses prose, an agent-audience card, and a human's page — naming edit_page", () => {
    for (const id of ["prose", "note-line", "shared", PAGE]) {
      expect(() => {
        assertAgentAuthored(scope, id);
      }).toThrow(/not agent-authored/);
    }
    // The primary error is a page id sent to Write, so its message points at the
    // tool that does take one — not at the deleted append tool — and names both
    // kinds of block the door does admit, off the handles.
    expect(() => {
      assertAgentAuthored(scope, PAGE);
    }).toThrow(/<agent-inline> or <agent-page>[\s\S]*edit_page/);
  });

  test("refuses an agent-note card that sits inside a withheld one", () => {
    const nested: BlockScope = {
      ...scope,
      rows: [...scope.rows, row("buried", "withheld", agentNotesBlock.type)],
    };
    expect(() => {
      assertAgentAuthored(nested, "buried");
    }).toThrow(/withheld from agents/);
  });

  test("ACCEPTS a card holding withheld content — the retired rule 4", () => {
    // This used to be a refusal, because the write diffed against the FULL stored
    // forest while the read was redacted, so the smuggled card arrived as a
    // deletion. The apply now redacts through the same filter as the read: the
    // card is invisible to the walk AND preserved by it (its `(parent_id, rank)`
    // key stays reserved), so there is nothing left to refuse.
    expect(() => {
      assertAgentAuthored(scope, "tainted");
    }).not.toThrow();
  });

  test("ACCEPTS a card holding a human-AUTHORED card — the door cannot judge that", () => {
    // `notes` holds `answer`. A door check could only refuse the whole card,
    // which would make the nesting useless; what actually matters — whether the
    // document echoed `answer` back or dropped it — is visible on the PLAN, and
    // the case below asserts the drop is refused there.
    expect(() => {
      assertAgentAuthored(scope, "notes");
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertAgentAuthoredPlan (rule 3)
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-07T00:00:00.000Z");

/** A created row, as `planMarkdownApply` mints one. */
const create = (id: string, parentId: string, type: string): Block => ({
  id,
  pageId: PAGE,
  parentId,
  type,
  data: {},
  rank: Rank.between(null, null),
  expanded: true,
  createdAt: NOW,
  updatedAt: NOW,
});

/**
 * A plan, hand-built. The predicate reads a plan and rows and nothing else, so
 * stating the patch directly is the most direct statement of each case — and it
 * is what lets a RETYPED SURVIVOR (the shape a parsed-forest walk could never
 * see) be expressed at all.
 */
function planOf(patch: {
  creates?: Block[];
  updates?: BlockUpdate[];
  deleteIds?: string[];
  textEdits?: MarkdownApplyPlan["textEdits"];
}): MarkdownApplyPlan {
  return {
    patch: {
      creates: patch.creates ?? [],
      updates: patch.updates ?? [],
      deleteIds: patch.deleteIds ?? [],
    },
    textEdits: patch.textEdits ?? [],
    stats: { survived: 0, created: 0, deleted: 0, moved: 0 },
  };
}

/** The page-rooted call `edit_page` makes. */
const judgePage = (plan: MarkdownApplyPlan): string[] =>
  assertAgentAuthoredPlan({
    plan,
    rows: scope.rows,
    pageRow: scope.pageRow,
    rootId: PAGE,
  });

/** The same judgement at any root of `scope`, over any rows. */
const judgeAt = (
  plan: MarkdownApplyPlan,
  rootId: string,
  rows: readonly StoredBlock[] = scope.rows,
): string[] =>
  assertAgentAuthoredPlan({ plan, rows, pageRow: scope.pageRow, rootId });

describe("assertAgentAuthoredPlan — every write inside a card", () => {
  test("accepts writes inside an existing card", () => {
    expect(
      judgePage(
        planOf({
          creates: [create("new-line", "notes", "text")],
          textEdits: [{ blockId: "note-line", runs: [{ text: "revised" }] }],
        }),
      ),
    ).toEqual(["notes"]);
  });

  test("accepts a new card at page level, and reports it as the card to stamp", () => {
    expect(
      judgePage(
        planOf({
          creates: [
            create("fresh", PAGE, agentNotesBlock.type),
            create("fresh-line", "fresh", "text"),
          ],
        }),
      ),
    ).toEqual(["fresh"]);
  });

  test("T4: a rank-only update to prose is exempt — minting a card re-ranks siblings", () => {
    // The carve-out the feature depends on: without it the predicate refuses the
    // ordinary case (a new card beside the prose it annotates).
    const cards = judgePage(
      planOf({
        creates: [create("fresh", PAGE, agentNotesBlock.type)],
        updates: [
          {
            id: "prose",
            ofType: "text",
            changes: { rank: Rank.between(null, null) },
          },
        ],
      }),
    );
    expect(cards).toEqual(["fresh"]);
  });

  test("refuses a text edit of prose — the page's own body is read-only", () => {
    expect(() => {
      judgePage(
        planOf({
          textEdits: [{ blockId: "prose", runs: [{ text: "hijacked" }] }],
        }),
      );
    }).toThrow(/was edited outside every agent-authored block/);
  });

  test("refuses deleting prose — and words it as a delete, not as a drag", () => {
    // A delete has only an OLD chain, so `side: "old"` says nothing `how` does
    // not; the carried-out wording ("this edit pulls a block into your card")
    // would be a claim about a move that never happened.
    expect(() => {
      judgePage(planOf({ deleteIds: ["prose"] }));
    }).toThrow(/was deleted outside every agent-authored block/);
  });

  test("refuses creating an ordinary block outside every card", () => {
    expect(() => {
      judgePage(planOf({ creates: [create("loose", PAGE, "text")] }));
    }).toThrow(/was created outside every agent-authored block/);
  });

  test("names the refused block by what it looks like, not only its minted id", () => {
    const worded = {
      ...create("loose", PAGE, "text"),
      data: { text: [{ text: "x".repeat(80) }] },
    };
    expect(() => {
      judgePage(planOf({ creates: [create("loose", PAGE, "text")] }));
    }).toThrow(/block loose \(an empty <text\/>\) was created/);
    expect(() => {
      judgePage(planOf({ creates: [worded] }));
    }).toThrow(
      new RegExp(`block loose \\(a <text> reading "${"x".repeat(60)}…"\\)`),
    );
  });

  test("T3: refuses MOVING prose into a card — the new chain is not enough", () => {
    // The attack the both-chains rule exists for: the whole page annexed into the
    // agent's own card, attributed to the agent, without deleting a character.
    expect(() => {
      judgePage(
        planOf({
          updates: [
            { id: "prose", ofType: "text", changes: { parentId: "notes" } },
          ],
        }),
      );
    }).toThrow(/did not COME from inside an agent-authored block/);
  });

  test("reports only the FIRST violation, and says how many there were", () => {
    // A page-rooted edit against a garbled document produces one violation per
    // block; three hundred copies of one sentence is not more informative.
    expect(() => {
      judgePage(
        planOf({
          deleteIds: ["prose", "shared"],
          textEdits: [{ blockId: "open", runs: [{ text: "x" }] }],
        }),
      );
    }).toThrow(
      /block prose \(an empty <text\/>\) was deleted[\s\S]*2 other writes in this edit/,
    );
  });

  test("a card-rooted apply may write anywhere inside its own card", () => {
    // `write_agent_note`'s shape: the root IS the boundary, so everything under
    // it passes — including a delete of the card's own line.
    expect(
      judgeAt(
        planOf({
          creates: [create("added", "notes", "text")],
          deleteIds: ["note-line"],
        }),
        "notes",
      ),
    ).toEqual(["notes"]);
  });
});

describe("assertAgentAuthoredPlan — a human-authored card is a hole in the agent's own", () => {
  test("refuses a text edit inside it — the page author's words, inside the agent's card", () => {
    expect(() => {
      judgePage(
        planOf({
          textEdits: [{ blockId: "answer-line", runs: [{ text: "no" }] }],
        }),
      );
    }).toThrow(
      /block answer-line was edited, and it sits inside <zz-authored> card answer/,
    );
  });

  test("refuses creating a block inside it", () => {
    expect(() => {
      judgePage(planOf({ creates: [create("intruder", "answer", "text")] }));
    }).toThrow(/sits inside <zz-authored> card answer/);
  });

  test("refuses deleting anything in it", () => {
    expect(() => {
      judgePage(planOf({ deleteIds: ["answer-line"] }));
    }).toThrow(
      /block answer-line was deleted, and it sits inside <zz-authored> card answer/,
    );
  });

  test("refuses deleting the card itself — which is what OMITTING it from a write plans", () => {
    // `write_agent_note` on `notes` composes a whole document; a document that
    // does not echo `<zz-authored id="answer">` back plans exactly this delete,
    // and the whole write is refused with nothing written.
    expect(() => {
      judgeAt(planOf({ deleteIds: ["answer", "answer-line"] }), "notes");
    }).toThrow(/the document deletes the <zz-authored> card answer/);
  });

  test("refuses MOVING a block out of it — the old chain is what catches this", () => {
    // The new chain resolves to `notes`, which is open, so an after-only test
    // would call this legal and let an agent launder a human's line into its own
    // card by re-indenting it.
    expect(() => {
      judgePage(
        planOf({
          updates: [
            {
              id: "answer-line",
              ofType: "text",
              changes: { parentId: "notes" },
            },
          ],
        }),
      );
    }).toThrow(/came from INSIDE <zz-authored> card answer/);
  });

  test("refuses moving the card itself", () => {
    expect(() => {
      judgePage(
        planOf({
          updates: [
            {
              id: "answer",
              ofType: humanish.type,
              changes: { parentId: PAGE },
            },
          ],
        }),
      );
    }).toThrow(/the document rewrites or moves the <zz-authored> card answer/);
  });

  test("an agent-note nested INSIDE it still admits writes — nearest wins both ways", () => {
    // The composition rule read in the other direction. A human may nest an
    // `<agent-inline>` card in their own; the walk stops at that card's `author:
    // "agent"` before it ever reaches the human one above.
    const rows = [
      ...scope.rows,
      row("reply", "answer", agentNotesBlock.type),
      row("reply-line", "reply", "text"),
    ];
    expect(
      judgeAt(
        planOf({
          textEdits: [{ blockId: "reply-line", runs: [{ text: "ok" }] }],
        }),
        PAGE,
        rows,
      ),
    ).toEqual(["reply"]);
  });

  test("an agent-note MINTED inside it is allowed, for the same reason", () => {
    // Self-inclusion, pointed the other way from the minting case below: the new
    // card declares `author: "agent"` at its own row, so the walk stops there and
    // never reaches the human card holding it. An agent may put its reply inside
    // the author's card; what it may not do is touch what the author wrote.
    expect(
      judgePage(
        planOf({ creates: [create("nested", "answer", agentNotesBlock.type)] }),
      ),
    ).toEqual(["nested"]);
  });

  test("ordinary writes elsewhere in the same card still pass, and stamp it", () => {
    // The hole shields itself and nothing else: the agent's own card is still
    // wholly its own everywhere the human did not claim.
    expect(
      judgePage(
        planOf({
          creates: [create("added", "notes", "text")],
          textEdits: [{ blockId: "note-line", runs: [{ text: "revised" }] }],
        }),
      ),
    ).toEqual(["notes"]);
  });
});

describe("assertAgentAuthoredPlan — minting a closed card is the SAME walk", () => {
  test("refuses minting a human-authored card, even INSIDE the agent's own", () => {
    // This is the case that used to be a rule of its own — a separate walk over
    // the plan's creates. It is asserted here to still fail, now through the
    // boundary walk: the created row declares `closed` at its OWN row, and the
    // walk is self-inclusive, so it never reaches the open card above.
    expect(() => {
      judgePage(
        planOf({ creates: [create("mine", "notes", privateish.type)] }),
      );
    }).toThrow(/the document creates a <zz-withheld> card/);
  });

  test("refuses minting one in open page body too — wherever it lands", () => {
    expect(() => {
      judgePage(planOf({ creates: [create("mine", PAGE, humanish.type)] }));
    }).toThrow(/the document creates a <zz-authored> card/);
  });

  test("the refusal says an agent may not author one, and where it MAY write", () => {
    expect(() => {
      judgePage(planOf({ creates: [create("mine", PAGE, privateish.type)] }));
    }).toThrow(
      /page AUTHOR's own words[\s\S]*<agent-inline>…<\/agent-inline> card instead/,
    );
  });

  test("refuses RETYPING a survivor into a human-authored card", () => {
    // The strictly-stronger half of judging the plan: a walk over the incoming
    // parsed forest sees a retyped survivor only as an ordinary node it cannot
    // tell from a create, so it could not judge this at all.
    expect(() => {
      judgePage(
        planOf({
          updates: [
            {
              id: "note-line",
              ofType: "text",
              changes: { type: privateish.type },
            },
          ],
        }),
      );
    }).toThrow(/turns block note-line into a <zz-withheld> card/);
  });
});

describe("assertAgentAuthoredPlan — a card inside a card", () => {
  // The rule that used to refuse these ("notes do not nest") is gone: nesting is
  // an ordinary shape, and the boundary judgement reads a nested card as inside a
  // card because it is one. What each case pins is the ATTRIBUTION, which is the
  // only thing nesting changes — `nearestCard` stamps the innermost card, never
  // the parent it sits in.

  test("accepts a card created inside an existing card, and stamps the inner one", () => {
    expect(
      judgePage(
        planOf({ creates: [create("nested", "notes", agentNotesBlock.type)] }),
      ),
    ).toEqual(["nested"]);
  });

  test("accepts a card created under a LINE that is inside a card", () => {
    // Nesting is a question about the whole chain, not about the direct parent —
    // and the chain answer is now "inside a card", not "refused".
    expect(
      judgePage(
        planOf({
          creates: [create("nested", "note-line", agentNotesBlock.type)],
        }),
      ),
    ).toEqual(["nested"]);
  });

  test("accepts a card created inside a card this same plan created", () => {
    // The after-forest is what resolves this at all: the enclosing card does not
    // exist in the stored rows, so only the plan's own creates put it on the chain.
    expect(
      new Set(
        judgePage(
          planOf({
            creates: [
              create("outer", PAGE, agentNotesBlock.type),
              create("inner", "outer", agentNotesBlock.type),
            ],
          }),
        ),
      ),
    ).toEqual(new Set(["outer", "inner"]));
  });

  test("a write inside a nested card stamps that card, not the one holding it", () => {
    expect(
      judgePage(
        planOf({
          creates: [create("line", "inner-existing", "text")],
        }),
      ),
    ).toEqual(["inner-existing"]);
  });

  test("still refuses a human-authored card minted inside a nested card", () => {
    // Nesting loosens the shape, not the write rule: the minted row declares
    // `closed` at itself, however many open cards are stacked above it.
    expect(() => {
      judgePage(
        planOf({
          creates: [create("mine", "inner-existing", privateish.type)],
        }),
      );
    }).toThrow(/the document creates a <zz-withheld> card/);
  });
});

describe("assertAgentAuthoredPlan — the cards to stamp", () => {
  test("names every card a single edit touched", () => {
    const cards = judgePage(
      planOf({
        creates: [create("fresh", PAGE, agentNotesBlock.type)],
        textEdits: [{ blockId: "note-line", runs: [{ text: "revised" }] }],
      }),
    );
    expect(new Set(cards)).toEqual(new Set(["fresh", "notes"]));
  });

  test("a human-authored card inside the target changes nothing about authorship", () => {
    // The hole is a write rule, not an attribution one: a legal write in `notes`
    // is still attributed to `notes`, which is the card whose `author: "agent"`
    // legalized it.
    expect(
      judgePage(planOf({ creates: [create("added", "notes", "text")] })),
    ).toEqual(["notes"]);
  });

  test("never names a card the plan DELETED — the authorship FK needs the row", () => {
    // Deleting a card is a legal write inside it (its chain reaches itself), but
    // `page_blocks_agent_authors.block_id` FKs onto a row that is about to stop
    // existing.
    expect(judgePage(planOf({ deleteIds: ["tainted"] }))).toEqual([]);
  });

  test("a rank-only update to prose attributes authorship to nobody", () => {
    expect(
      judgePage(
        planOf({
          updates: [
            {
              id: "prose",
              ofType: "text",
              changes: { rank: Rank.between(null, null) },
            },
          ],
        }),
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Agent-authored pages: the page row declares through its own data
// ---------------------------------------------------------------------------

/** An agent-authored page's `data`, as the planner mints and the row stores it. */
const agentPageData = (title: string) => ({
  title,
  icon: null,
  author: "agent" as const,
});

/** A row with a real payload — `row()` gives `{}`, which a page cannot hold. */
function rowWith(
  id: string,
  parentId: string,
  type: string,
  data: unknown,
): StoredBlock {
  return { ...row(id, parentId, type), data };
}

/**
 * An agent-authored page's OWN scope — what `loadBlockScope(<its id>)` returns,
 * since a page's content is written by its own id:
 *
 * ```
 * apage                 (page, author: agent)
 * ├── a-line
 * ├── a-answer          (audience: agent, author: human)
 * │   └── a-answer-line
 * └── a-sub             (a human's sub-page, a shell here)
 * ```
 */
const APAGE = "apage";
const agentScope: BlockScope = {
  pageId: APAGE,
  title: "Findings",
  pageRow: { id: APAGE, type: "page", data: agentPageData("Findings") },
  rows: [
    row("a-line", APAGE, "text"),
    row("a-answer", APAGE, humanish.type),
    row("a-answer-line", "a-answer", "text"),
    rowWith("a-sub", APAGE, "page", { title: "Sub", icon: null }),
  ],
};
const judgeAgentPage = (plan: MarkdownApplyPlan): string[] =>
  assertAgentAuthoredPlan({
    plan,
    rows: agentScope.rows,
    pageRow: agentScope.pageRow,
    rootId: APAGE,
  });
/** A row created in the agent page's partition. */
const createIn = (id: string, parentId: string, type: string): Block => ({
  ...create(id, parentId, type),
  pageId: APAGE,
});

describe("an agent-authored page — every block in it is the agent's", () => {
  test("writes to its own prose are accepted, and stamp the PAGE", () => {
    expect(
      judgeAgentPage(
        planOf({
          textEdits: [{ blockId: "a-line", runs: [{ text: "revised" }] }],
          creates: [createIn("a-new", APAGE, "text")],
        }),
      ),
    ).toEqual([APAGE]);
  });

  test("deleting its prose and moving a line are accepted too — both chains open", () => {
    expect(
      judgeAgentPage(
        planOf({
          deleteIds: ["a-line"],
          updates: [
            {
              id: "a-sub",
              ofType: "page",
              changes: { rank: Rank.between(null, null) },
            },
          ],
        }),
      ),
    ).toEqual([APAGE]);
  });

  test("a human-authored card inside it is still a hole", () => {
    expect(() => {
      judgeAgentPage(
        planOf({
          textEdits: [{ blockId: "a-answer-line", runs: [{ text: "no" }] }],
        }),
      );
    }).toThrow(/sits inside <zz-authored> card a-answer/);
  });

  test("minting a human-authored card inside it is refused at its own row", () => {
    expect(() => {
      judgeAgentPage(
        planOf({ creates: [createIn("mine", APAGE, humanish.type)] }),
      );
    }).toThrow(/the document creates a <zz-authored> card/);
  });

  test("a HUMAN's page is not: the same edit on it is refused as escaped", () => {
    expect(() => {
      judgePage(
        planOf({ textEdits: [{ blockId: "prose", runs: [{ text: "x" }] }] }),
      );
    }).toThrow(/outside every agent-authored block/);
  });
});

describe("minting an agent-authored page", () => {
  /** A page row the planner mints: in THIS page, its body in its own partition. */
  const mintedPage = (id: string, parentId: string, title: string): Block => ({
    ...create(id, parentId, "page"),
    data: agentPageData(title),
    expanded: false,
  });
  const bodyOf = (id: string, pageId: string): Block => ({
    ...create(id, pageId, "text"),
    pageId,
  });

  test("at the human page's top level is legal, and stamps the NEW page as its creator", () => {
    expect(
      judgePage(
        planOf({
          creates: [
            mintedPage("new-page", PAGE, "Findings"),
            bodyOf("new-line", "new-page"),
          ],
        }),
      ),
    ).toEqual(["new-page"]);
  });

  test("inside an agent-inline card too — the new page is still its own nearest", () => {
    expect(
      judgePage(
        planOf({ creates: [mintedPage("new-page", "notes", "Findings")] }),
      ),
    ).toEqual(["new-page"]);
  });

  test("a minted page WITHOUT the agent marker is prose, and refused", () => {
    const humanPage: Block = {
      ...create("sneaky", PAGE, "page"),
      data: { title: "Mine now", icon: null },
    };
    expect(() => {
      judgePage(planOf({ creates: [humanPage] }));
    }).toThrow(/was created outside every agent-authored block/);
  });

  test("a minted page's body inside a human card stays refused — nearest wins", () => {
    expect(() => {
      judgePage(
        planOf({
          creates: [
            mintedPage("new-page", PAGE, "Findings"),
            {
              ...create("n-card", "new-page", humanish.type),
              pageId: "new-page",
            },
          ],
        }),
      );
    }).toThrow(/the document creates a <zz-authored> card/);
  });
});

describe("the door admits an agent-authored page, by its own row", () => {
  test("write_agent_note on the page's own id is admitted", () => {
    expect(() => {
      assertAgentAuthored(agentScope, APAGE);
    }).not.toThrow();
  });

  test("…and refused for a human's page, naming what it is", () => {
    expect(() => {
      assertAgentAuthored(scope, PAGE);
    }).toThrow(/page page is a <page> its author wrote, not agent-authored/);
  });
});

describe("a NESTED root takes what its ancestry declares — the stated behaviour change", () => {
  const rows = [
    ...scope.rows,
    row("note-para", "notes", "text"),
    row("note-para-child", "note-para", "text"),
  ];

  test("rooted at a line INSIDE an agent-inline card, a write is ACCEPTED", () => {
    // It used to be refused: the engine's walk hit the undeclared root and
    // answered "outside every card", while the card holding the root said the
    // opposite. The enclosure is that card, so the write resolves inside it —
    // and is attributed to it.
    expect(
      judgeAt(
        planOf({
          creates: [create("n", "note-para", "text")],
          textEdits: [{ blockId: "note-para-child", runs: [{ text: "x" }] }],
        }),
        "note-para",
        rows,
      ),
    ).toEqual(["notes"]);
  });

  test("rooted at a line inside a <human> card it stays refused, now as enclosed — naming the card", () => {
    expect(() => {
      judgeAt(
        planOf({ creates: [create("n", "answer-line", "text")] }),
        "answer-line",
      );
    }).toThrow(/sits inside <zz-authored> card answer/);
  });

  test("rooted at a line of prose it stays escaped", () => {
    expect(() => {
      judgeAt(planOf({ creates: [create("n", "prose", "text")] }), "prose");
    }).toThrow(/outside every agent-authored block/);
  });
});

describe("refusal wording names BOTH kinds, off the handles", () => {
  test("an escaped write names <agent-inline> and <agent-page> as where writes go", () => {
    expect(() => {
      judgePage(planOf({ deleteIds: ["prose"] }));
    }).toThrow(/inside an <agent-inline> or <agent-page>/);
  });

  test("and tells the agent to mint the INLINE card, by its tag — never its stored type", () => {
    let message = "";
    try {
      judgePage(planOf({ creates: [create("loose", PAGE, "text")] }));
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      message = err.message;
    }
    expect(message).toContain("<agent-inline>…</agent-inline>");
    expect(message).not.toContain("agent-note");
  });
});

// ---------------------------------------------------------------------------
// inertEmptyParagraphs — the layout an edit leaves alone
// ---------------------------------------------------------------------------

describe("inertEmptyParagraphs", () => {
  const inertAt = (rootId: string, rows = scope.rows) =>
    inertEmptyParagraphs({ rows, pageRow: scope.pageRow, rootId });
  const rowById = (id: string): StoredBlock =>
    scope.rows.find((r) => r.id === id)!;
  const node = (type: string, data: unknown = {}) => ({
    type,
    data,
    expanded: true,
    children: [],
  });
  const empty = node("text");

  test("a stored empty paragraph is inert unless an agent-authored block holds it", () => {
    const inert = inertAt(PAGE);
    expect(inert.row(rowById("prose"))).toBe(true);
    // Inside a human-authored card: as closed to the agent as the prose.
    expect(inert.row(rowById("open"))).toBe(true);
    expect(inert.row(rowById("answer-line"))).toBe(true);
    // The agent's own card.
    expect(inert.row(rowById("note-line"))).toBe(false);
  });

  test("a row with text, a row with children, or another type is never inert", () => {
    const inert = inertAt(PAGE);
    expect(
      inert.row({ ...rowById("prose"), data: { text: [{ text: "words" }] } }),
    ).toBe(false);
    expect(inert.row(rowById("secret"))).toBe(false);
    expect(inert.row(rowById("shared"))).toBe(false);
  });

  test("a document node reads its chain off its document ancestors, then the root", () => {
    const atPage = inertAt(PAGE);
    expect(atPage.node(empty, [])).toBe(true);
    expect(atPage.node(empty, [node(agentNotesBlock.type)])).toBe(false);
    // Nearest declaration wins: a human's card inside the agent's card is theirs.
    expect(
      atPage.node(empty, [node(humanish.type), node(agentNotesBlock.type)]),
    ).toBe(true);
    expect(atPage.node(node("text", { text: [{ text: "x" }] }), [])).toBe(
      false,
    );
    expect(atPage.node({ ...empty, children: [node("text")] }, [])).toBe(false);
    // Rooted at the agent's card, the top level IS the card's.
    expect(inertAt("notes").node(empty, [])).toBe(false);
    // Rooted at a human's card, or at prose, it is not.
    expect(inertAt("shared").node(empty, [])).toBe(true);
    expect(inertAt("secret").node(empty, [])).toBe(true);
  });

  test("a minted agent page's body is the agent's", () => {
    const page = node("page", agentPageData("New"));
    expect(inertAt(PAGE).node(empty, [page])).toBe(false);
  });

  test("on an agent-authored page nothing is inert", () => {
    const inert = inertEmptyParagraphs({
      rows: agentScope.rows,
      pageRow: agentScope.pageRow,
      rootId: APAGE,
    });
    expect(inert.row(agentScope.rows.find((r) => r.id === "a-line")!)).toBe(
      false,
    );
    expect(inert.node(empty, [])).toBe(false);
    // …except inside the human's card on it.
    expect(
      inert.row(agentScope.rows.find((r) => r.id === "a-answer-line")!),
    ).toBe(true);
  });
});
