import { describe, expect, test } from "bun:test";
import { pgTable, text } from "drizzle-orm/pg-core";
import {
  ExcludeFromFork,
  ExcludeSchemaDataFromFork,
  forkExclusionsFrom,
} from "./fork-exclusion";

// `forkExclusionsFrom` is what `./equin db fork` reads the declared set with,
// off loaded plugin definitions and without a booted backend — so it must read
// both kinds off any definition list, and refuse an empty one rather than hand
// back "exclude nothing" (a full ~2 GB fork that looks like it worked).

const traces = pgTable("traces_fixture", { id: text("id").primaryKey() });

describe("forkExclusionsFrom", () => {
  test("reads both kinds off plain definitions, table objects by their pg name", () => {
    const plugins = [
      {
        contributions: [
          ExcludeFromFork({ table: traces, reason: "observability" }),
          ExcludeFromFork({ table: "live_state_snapshot", reason: "derived" }),
        ],
      },
      {},
      {
        contributions: [
          ExcludeSchemaDataFromFork({
            schema: "graphile_worker",
            keep: ["migrations"],
            reason: "queue bookkeeping",
          }),
        ],
      },
    ];
    expect(forkExclusionsFrom(plugins)).toEqual({
      tables: ["traces_fixture", "live_state_snapshot"],
      schemas: [{ schema: "graphile_worker", keep: ["migrations"] }],
    });
  });

  test("throws on a graph that declares no exclusion", () => {
    expect(() => forkExclusionsFrom([{ contributions: [] }, {}])).toThrow(
      "no fork exclusions are declared by any loaded plugin",
    );
  });
});
