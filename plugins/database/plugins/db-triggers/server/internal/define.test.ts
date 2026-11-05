import { describe, test, expect } from "bun:test";
import { defineDbTriggers } from "./define";

const FN = {
  name: "f",
  args: "",
  ddl: `CREATE OR REPLACE FUNCTION f() RETURNS trigger AS $x$ BEGIN RETURN NULL; END; $x$ LANGUAGE plpgsql`,
};

function withTrigger(name: string, table: string, ddl: string) {
  return () =>
    defineDbTriggers({
      id: "t",
      functions: [FN],
      triggers: [{ name, table, ddl }],
    });
}

describe("defineDbTriggers reads identifiers as Postgres does", () => {
  test("a quoted mixed-case or hyphenated name is verbatim", () => {
    expect(
      withTrigger(
        "live_state_conversation_turn-completed_triggers_i",
        "conversation_turn-completed_triggers",
        `CREATE OR REPLACE TRIGGER "live_state_conversation_turn-completed_triggers_i" AFTER INSERT ON "conversation_turn-completed_triggers" FOR EACH STATEMENT EXECUTE FUNCTION f()`,
      ),
    ).not.toThrow();
    expect(
      withTrigger(
        "tasks_statusChanged_i",
        "tasks_statusChanged_triggers",
        `CREATE OR REPLACE TRIGGER "tasks_statusChanged_i" AFTER INSERT ON public."tasks_statusChanged_triggers" FOR EACH STATEMENT EXECUTE FUNCTION f()`,
      ),
    ).not.toThrow();
  });

  test("an embedded quote is doubled", () => {
    expect(
      withTrigger(
        'a"b',
        "t",
        `CREATE OR REPLACE TRIGGER "a""b" AFTER INSERT ON t FOR EACH STATEMENT EXECUTE FUNCTION f()`,
      ),
    ).not.toThrow();
  });

  test("an unquoted name folds to lower case", () => {
    expect(
      withTrigger(
        "trg",
        "widgets",
        `CREATE OR REPLACE TRIGGER TRG AFTER INSERT ON Widgets FOR EACH STATEMENT EXECUTE FUNCTION f()`,
      ),
    ).not.toThrow();
    expect(
      withTrigger(
        "Trg",
        "widgets",
        `CREATE OR REPLACE TRIGGER Trg AFTER INSERT ON widgets FOR EACH STATEMENT EXECUTE FUNCTION f()`,
      ),
    ).toThrow(/must start with/);
  });

  test("a table other than the declared one is refused", () => {
    expect(
      withTrigger(
        "trg",
        "Widgets",
        `CREATE OR REPLACE TRIGGER trg AFTER INSERT ON Widgets FOR EACH STATEMENT EXECUTE FUNCTION f()`,
      ),
    ).toThrow(/must be `ON public.Widgets`/);
  });
});
