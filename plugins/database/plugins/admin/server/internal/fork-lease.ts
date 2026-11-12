import { z } from "zod";
import { queryOne } from "@plugins/database/plugins/sql-rows/core";
import { dropDatabase } from "./databases";
import { createAdminSession } from "./pool";

// Is a fork temp still being worked on? Its LEASE says so: a session-held
// advisory lock keyed by the temp's name, on the `postgres` system DB.
//
// The fork takes it BEFORE `CREATE DATABASE` and holds it until the temp is
// renamed to its target or dropped, so there is no instant at which a live
// temp exists unleased. The lock lives with the forking process's session: a
// fork that dies — killed, crashed, its host rebooted — releases it with its
// connection, and that temp is an orphan the sweep may take.
//
// It replaces "zero connections to the temp", which is not liveness: a fork
// holds no connection to its temp while it waits for the host `db-fork` slot
// and for the whole `pg_dump` (only `pg_restore` connects to it), so a sweep
// landing in that window dropped a live temp and the restore failed with
// `database "f_…__forking" does not exist`.

// The advisory-lock class of fork leases (the two-int4 form, so no key is
// shared with the jobs plugin's bigint locks or the schema-generation class).
const FORK_LEASE_CLASS = 1718579819;

// `hashtext` maps the name to an int4 server-side. Two temps colliding on it
// (1 in 2^32) can only err toward keeping: the sweep skips an orphan until the
// live fork is done, or a fork refuses loudly and its job retries a new name.
const TRY_LOCK = "SELECT pg_try_advisory_lock($1, hashtext($2)) AS ok";

async function openLease(
  temp: string,
): Promise<{ ok: boolean; release: () => Promise<void> }> {
  const session = await createAdminSession("fork-lease");
  await session.connect();
  try {
    const { ok } = await queryOne(session, {
      sql: TRY_LOCK,
      params: [FORK_LEASE_CLASS, temp],
      row: z.object({ ok: z.boolean() }),
    });
    // Ending the session releases the lock; no explicit unlock to forget.
    return { ok, release: () => session.end() };
  } catch (err) {
    await session.end();
    throw err;
  }
}

/**
 * Run `fn` holding `temp`'s fork lease. The temp name is per-invocation unique
 * (`forkTempName`), so nothing else can hold it: a refusal is a broken
 * assumption, thrown.
 */
export async function withForkTempLease<T>(
  temp: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lease = await openLease(temp);
  try {
    if (!lease.ok) {
      throw new Error(
        `fork lease for ${temp} is already held — a temp name (or its hash) collided with a live fork`,
      );
    }
    return await fn();
  } finally {
    await lease.release();
  }
}

/**
 * Drop `temp` if no fork holds its lease — the sweep's whole test. The lease
 * stays held across the drop, so a fork cannot start on the name meanwhile.
 */
export async function reclaimForkTemp(
  temp: string,
): Promise<"dropped" | "in-use"> {
  const lease = await openLease(temp);
  try {
    if (!lease.ok) return "in-use";
    await dropDatabase({
      unserved: temp,
      reason:
        "an orphaned fork temp: never published, so no backend boots on it",
    });
    return "dropped";
  } finally {
    await lease.release();
  }
}
