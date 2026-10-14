import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import {
  and,
  canonicalizeFilter,
  clause,
  type Filter,
  type Filterable,
} from "@plugins/network/plugins/live/plugins/filter/core";
import type {
  FieldDef,
  FilterGroup,
  FilterOperatorSet,
} from "@plugins/primitives/plugins/data-view/core";
import {
  deriveFields,
  lowerFilterGroup,
  renameColumns,
  resolveLiveFields,
} from "@plugins/primitives/plugins/data-view/web/testing";
import { tagsOperatorSet } from "@plugins/fields/plugins/tags/plugins/filter/web/testing";
import { boolOperatorSet } from "@plugins/fields/plugins/bool/plugins/filter/web/testing";
import { mailAccountIdKind } from "@plugins/apps/plugins/mail/plugins/mail-core/core";
import { mailThreads, type MailThreadRow } from "../../core";
import { mailThreadsSource } from "../internal/source";

/**
 * The eight mailbox tabs are AUTHORED CONFIG, not code — and a rule whose
 * `fieldId` or `operatorId` does not resolve is dangling: it lowers to nothing,
 * so that tab silently shows every thread in the account instead of its
 * mailbox. Nothing else in the system would notice.
 *
 * So this suite reads the real config file and lowers each authored filter
 * through the REAL operator sets the Filter control runs, over the fields the
 * list DERIVES from `mailThreads`, asserting every tab lowers to its scope —
 * and that the scope, renamed by the live source's own field plan to its
 * columns, is a filter the collection's declaration accepts. It is the only thing standing between a typo'd operator id and a
 * Spam tab showing the inbox.
 */
const CONFIG_PATH = join(
  __dirname,
  // __tests__ → web → threads → plugins → mail → plugins → apps → plugins → repo root
  "../../../../../../../..",
  "config/apps/mail/threads/mail-threads.jsonc",
);

interface AuthoredRow {
  id: string;
  name: string;
  view: { type: string; sort?: unknown[]; filter?: FilterGroup };
}

function authoredViews(): AuthoredRow[] {
  const errors: { error: number; offset: number; length: number }[] = [];
  const doc = parseJsonc(readFileSync(CONFIG_PATH, "utf8"), errors) as {
    views?: AuthoredRow[];
  };
  if (errors.length > 0) {
    throw new Error(
      `${CONFIG_PATH} is not parseable JSONC: ${JSON.stringify(errors)}`,
    );
  }
  const views = doc.views ?? [];
  if (views.length === 0) throw new Error(`${CONFIG_PATH} authored no views`);
  return views;
}

const SETS: FilterOperatorSet[] = [tagsOperatorSet, boolOperatorSet];
const resolve = (typeId: string): FilterOperatorSet | undefined =>
  SETS.find((s) => s.match === typeId);

// The fields the pane's DataView derives from the collection — what the
// authored rules name.
const fields = deriveFields(mailThreads, true, [])
  .fields as FieldDef<MailThreadRow>[];

describe("the threads list's field ids", () => {
  it("are the vocabulary the authored tabs and saved views name", () => {
    expect(fields.map((f) => f.id)).toEqual([
      "subject",
      "lastMessageAt",
      "unread",
      "starred",
      "important",
      "hasAttachments",
      "messageCount",
      "snippet",
      "accountId",
      "labels",
    ]);
  });
});

// The live source's real field plan — which fields the Filter control offers
// and the column each lowers to — under the pane's account scope.
const plan = resolveLiveFields(
  fields,
  mailThreadsSource.scoped({
    where: { accountId: mailAccountIdKind.key("account") },
  }),
  resolve,
  "authored-views test",
);

const FILTERABLE: Filterable = mailThreads.filterable;

const labels = (op: "hasAll" | "hasNone", tag: string) =>
  clause("labels", op, [tag]);

const EXPECTED: Record<string, Filter> = {
  inbox: labels("hasAll", "INBOX"),
  starred: clause("starred", "eq", true),
  important: clause("important", "eq", true),
  sent: labels("hasAll", "SENT"),
  drafts: labels("hasAll", "DRAFT"),
  all: and(labels("hasNone", "SPAM"), labels("hasNone", "TRASH")),
  spam: labels("hasAll", "SPAM"),
  trash: labels("hasAll", "TRASH"),
};

describe("the authored mailbox tabs lower to their scope", () => {
  it("the config authors exactly the eight expected mailbox ids, in order", () => {
    expect(authoredViews().map((v) => v.id)).toEqual(Object.keys(EXPECTED));
  });

  it("every tab carries an explicit slug id, a name, and the date-desc sort", () => {
    for (const row of authoredViews()) {
      expect(row.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(row.name.length).toBeGreaterThan(0);
      expect(row.view.type).toBe("list");
      expect(row.view.sort).toEqual([
        { fieldId: "lastMessageAt", direction: "desc" },
      ]);
    }
  });

  for (const row of authoredViews()) {
    it(`"${row.id}" lowers its scope instead of dangling`, () => {
      const expected = EXPECTED[row.id];
      if (!expected) throw new Error(`unexpected authored view id "${row.id}"`);
      const { filter } = lowerFilterGroup(
        row.view.filter ?? null,
        plan.filterFields,
        resolve,
        0,
      );
      if (filter === undefined) throw new Error("the tab lowered no filter");
      // The live source's own rename, field id → column.
      const renamed = renameColumns(filter, (id) => {
        const column = plan.columnOf.get(id);
        if (column === undefined)
          throw new Error(`"${id}" lowers to no column`);
        return column;
      });
      expect(canonicalizeFilter(renamed, FILTERABLE)).toEqual(
        canonicalizeFilter(expected, FILTERABLE),
      );
    });
  }
});
