import { describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { createServer } from "net";
import { queryRows } from "@plugins/database/plugins/sql-rows/core";
import { z } from "zod";
import { withDirectConnection, withDirectDb } from "./direct-db";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";

// The `no-database` / `ok` / propagation cases talk to the live gateway-owned
// cluster (read-only: nothing is created, so no throwaway-DB fixture is
// needed). Only the `unreachable` case avoids it, by dialing a TCP port nothing
// listens on.
//
// Not a missing unix-socket dir: under bun:test (only — a plain `bun` process
// is fine) Bun emits that ENOENT on the socket before pg has attached its
// 'error' listener, so the runner records an uncaught error even though the
// helper still returns `unreachable`.

// A loopback port that was just free: bind an ephemeral one, then release it.
async function refusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error(`unexpected server address: ${String(address)}`);
  }
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  return address.port;
}

// Await `p` and return what it rejected with; throw if it resolved.
// `expect(p).rejects.…` is typed `void` under bun:test (see the spawn suite's
// identical helper), so this asserts the rejection for real.
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

describe("withDirectDb", () => {
  test("unreachable: nothing listens at the address — fn never runs", async () => {
    let ran = false;
    const result = await withDirectConnection(
      `postgres://nobody@127.0.0.1:${await refusedPort()}/${MAIN_WORKTREE_NAME}`,
      async () => {
        ran = true;
        return 1;
      },
    );
    expect(result.kind).toBe("unreachable");
    if (result.kind !== "unreachable") throw new Error(`got ${result.kind}`);
    // The cause carries how long the connect attempt took.
    expect(result.cause).toMatch(/\(after \d+ ms\)$/);
    expect(ran).toBe(false);
  });

  test("no-database: a database that was never created (3D000)", async () => {
    let ran = false;
    const result = await withDirectDb(
      `direct_db_test_missing_${randomUUID().replaceAll("-", "")}`,
      async () => {
        ran = true;
        return 1;
      },
    );
    expect(result).toEqual({ kind: "no-database" });
    expect(ran).toBe(false);
  });

  test("ok: fn's value comes back", async () => {
    const result = await withDirectDb(MAIN_WORKTREE_NAME, (pool) =>
      queryRows(pool, {
        sql: "SELECT 1::int AS one",
        row: z.object({ one: z.number() }),
      }),
    );
    expect(result).toEqual({ kind: "ok", value: [{ one: 1 }] });
  });

  test("an error thrown inside fn propagates unclassified", async () => {
    const err = await rejection(
      withDirectDb(MAIN_WORKTREE_NAME, async () => {
        throw new Error("boom from fn");
      }),
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("boom from fn");
  });

  test("errors from fn are never reclassified, even one carrying 3D000", async () => {
    // Classification is structural (only the pre-fn probe is classified), so
    // an error code that WOULD mean `no-database` at connect time is not
    // reinterpreted when fn throws it.
    const coded = Object.assign(new Error("coded from fn"), { code: "3D000" });
    expect(
      await rejection(
        withDirectDb(MAIN_WORKTREE_NAME, async () => {
          throw coded;
        }),
      ),
    ).toBe(coded);

    expect(
      await rejection(
        withDirectDb(MAIN_WORKTREE_NAME, (pool) =>
          queryRows(pool, {
            sql: "SELECT 1 FROM direct_db_test_no_such_table",
            row: z.object({}),
          }),
        ),
      ),
    ).toMatchObject({ code: "42P01" });
  });
});
