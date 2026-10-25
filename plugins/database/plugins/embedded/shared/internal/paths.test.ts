import { describe, expect, test } from "bun:test";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import { PG_BASE_DATABASE } from "./paths";

describe("PG_BASE_DATABASE", () => {
  // The base database is the main namespace's database; two owners, held together here.
  test("is main's namespace", () => {
    expect<string>(PG_BASE_DATABASE).toBe(MAIN_WORKTREE_NAME);
  });
});
