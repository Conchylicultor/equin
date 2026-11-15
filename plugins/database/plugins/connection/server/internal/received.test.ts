import { afterAll, expect, test } from "bun:test";
import { Client } from "pg";
import {
  PG_PORT,
  PG_SOCKET_DIR,
  PG_USER,
} from "@plugins/database/plugins/embedded/server";
import { createDbClient, receivedSoFar } from "./client";

// `receivedSoFar` against the REAL cluster, over its Unix socket — the path
// every backend's reply takes. Table-free statements on the `postgres`
// maintenance database. Requires the running embedded cluster (./equin build).

const client = createDbClient({
  name: "events-test",
  connectionString: `postgres://${PG_USER}@/postgres?host=${encodeURIComponent(PG_SOCKET_DIR)}&port=${PG_PORT}`,
});
await client.connect();

afterAll(async () => {
  await client.end();
});

test("a statement's reply is counted in reads and bytes", async () => {
  const before = receivedSoFar(client);
  await client.query("select repeat('x', 200000) as s");
  const big = receivedSoFar(client);
  expect(big.bytes - before.bytes).toBeGreaterThanOrEqual(200_000);
  expect(big.reads - before.reads).toBeGreaterThanOrEqual(1);

  await client.query("select 1 as n");
  const small = receivedSoFar(client);
  expect(small.bytes - big.bytes).toBeLessThan(1_000);
  expect(small.reads - big.reads).toBeGreaterThanOrEqual(1);
});

test("a client this plugin did not build is refused", () => {
  expect(() => receivedSoFar(new Client())).toThrow(/createDbPool/);
});
