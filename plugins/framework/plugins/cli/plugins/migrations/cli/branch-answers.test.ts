import { describe, expect, test } from "bun:test";
import { branchAnswers, createdEntityKeys } from "./branch-answers";
import type { MigrationAnswer } from "./migrations-interactive";

const create: MigrationAnswer = { action: "create" };

describe("createdEntityKeys", () => {
  test("reads every entity a branch migration creates, keyed as drizzle prompts name it", () => {
    const sql = [
      "-- equin:snapshot id=a parents=b",
      'CREATE TABLE "claude_usage_hours" (\n\t"id" text PRIMARY KEY\n);',
      "--> statement-breakpoint",
      'CREATE TABLE IF NOT EXISTS "public"."claude_model_rates" ("id" text);',
      "--> statement-breakpoint",
      'CREATE TABLE "audit"."events" ("id" text);',
      "--> statement-breakpoint",
      'ALTER TABLE "tasks" ADD COLUMN "priority" integer;',
      "--> statement-breakpoint",
      'ALTER TABLE "public"."tasks" ADD COLUMN IF NOT EXISTS "owner" text;',
      "--> statement-breakpoint",
      `CREATE TYPE "public"."mood" AS ENUM('a', 'b');`,
      "--> statement-breakpoint",
      'CREATE VIEW "public"."tasks_v" AS select 1;',
      "--> statement-breakpoint",
      'DROP TABLE "claude_spend_hours" CASCADE;',
      "--> statement-breakpoint",
      'ALTER TABLE "tasks" RENAME COLUMN "a" TO "b";',
    ].join("\n");
    expect([...createdEntityKeys([sql])].sort()).toEqual(
      [
        "column:tasks.owner",
        "column:tasks.priority",
        "enum:mood",
        "table:audit.events",
        "table:claude_model_rates",
        "table:claude_usage_hours",
        "view:tasks_v",
      ].sort(),
    );
  });

  test("a statement only mentioned in a comment creates nothing", () => {
    expect(
      createdEntityKeys(['-- CREATE TABLE "ghost" (\nSELECT 1;']).size,
    ).toBe(0);
  });
});

describe("branchAnswers", () => {
  test("a table the branch created is answered create (the 2026-11-16 push)", () => {
    const answers = branchAnswers(
      new Map([["table:claude_spend_days", create]]),
      new Set(["table:claude_usage_hours", "table:claude_spend_days"]),
    );
    expect(answers.get("table:claude_usage_hours")).toEqual(create);
    expect(answers.get("table:claude_spend_days")).toEqual(create);
  });

  test("a recorded rename of a published entity is kept", () => {
    const rename: MigrationAnswer = { action: "rename", from: "old" };
    expect(
      branchAnswers(new Map([["table:new", rename]]), new Set()).get(
        "table:new",
      ),
    ).toEqual(rename);
  });

  test("a rename of something the branch created composes to create", () => {
    expect(
      branchAnswers(
        new Map([["column:t.z", { action: "rename", from: "x" }]]),
        new Set(["column:t.x"]),
      ).get("column:t.z"),
    ).toEqual(create);
  });

  test("a chain of renames composes to its published source", () => {
    const answers = branchAnswers(
      new Map<string, MigrationAnswer>([
        ["table:b", { action: "rename", from: "a" }],
        ["table:c", { action: "rename", from: "b" }],
      ]),
      new Set(),
    );
    expect(answers.get("table:c")).toEqual({ action: "rename", from: "a" });
  });

  test("a rename loop fails loudly", () => {
    expect(() =>
      branchAnswers(
        new Map<string, MigrationAnswer>([
          ["table:a", { action: "rename", from: "b" }],
          ["table:b", { action: "rename", from: "a" }],
        ]),
        new Set(),
      ),
    ).toThrow(/loop/);
  });
});
