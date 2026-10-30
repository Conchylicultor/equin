/**
 * The decoder against a REAL `pgTable`, because two of the guarantees only exist
 * once drizzle has built the column:
 *
 *  - `getSQLType()` is `"text"`, which is the whole reason adopting `parsedText`
 *    generates no migration;
 *  - the error names `table.column`, which depends on drizzle calling the
 *    decoder as a method (`this.mapFrom(v)`). That is measured behaviour, not a
 *    documented contract, so it is pinned here: a future drizzle that detaches
 *    the call degrades the label, and this suite is what makes the degrade loud
 *    instead of quiet.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { pgTable, text } from "drizzle-orm/pg-core";
import { tolerantEnum } from "@plugins/primitives/plugins/live-state/core";
import { parsedText } from "./parsed-text";
import { SqlColumnError } from "./errors";

const JobWaitStatusSchema = z.enum([
  "pending",
  "resolved",
  "timed_out",
  "cancelled",
]);

const jobWaits = pgTable("job_waits", {
  status: parsedText("status", JobWaitStatusSchema).notNull(),
  // A nullable sibling: no `.notNull()`, so drizzle types it `… | null` on its
  // own. The decoder says nothing about nullability and is never handed a null.
  lastStatus: parsedText("last_status", JobWaitStatusSchema),
});

describe("the column drizzle builds", () => {
  test("is a plain `text` column, so adopting it needs no migration", () => {
    const plain = pgTable("t", { s: text("s") });
    expect(jobWaits.status.getSQLType()).toBe("text");
    expect(jobWaits.status.getSQLType()).toBe(plain.s.getSQLType());
  });

  test("carries nullability from the builder, not from the decoder", () => {
    expect(jobWaits.status.notNull).toBe(true);
    expect(jobWaits.lastStatus.notNull).toBe(false);
  });
});

describe("reading", () => {
  test("a value in the set passes through", () => {
    expect(jobWaits.status.mapFromDriverValue("resolved")).toBe("resolved");
  });

  test("a value outside the set throws, naming the qualified column", () => {
    let err: unknown;
    try {
      jobWaits.status.mapFromDriverValue("running");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SqlColumnError);
    const e = err as SqlColumnError;
    // The qualified label is the measured `this`-binding behaviour. If drizzle
    // ever stops calling the decoder as a method this assertion is what fails.
    expect(e.label).toBe("job_waits.status");
    expect(e.direction).toBe("read");
    expect(e.received).toBe("running");
    expect(e.message).toContain("job_waits.status");
    expect(e.message).toContain("decoding a value out of Postgres");
    // zod's enum message lists the allowed values — that is the actionable half.
    expect(e.message).toContain('"pending"');
    expect(e.message).toContain('"cancelled"');
    expect(e.message).toContain("tolerantEnum");
    expect(e.cause).toBeInstanceOf(z.ZodError);
  });

  test("a null is not absorbed — drizzle guards it upstream, so reaching the decoder is a bug", () => {
    // `mapResultRow` does `rawValue === null ? null : decode` (utils.js:28), so
    // a null here would mean the guarantee changed. It must not read as "".
    expect(() => jobWaits.status.mapFromDriverValue(null as never)).toThrow(
      SqlColumnError,
    );
  });

  test("a non-string names its runtime type in the message", () => {
    let err: unknown;
    try {
      jobWaits.status.mapFromDriverValue(7 as never);
    } catch (e) {
      err = e;
    }
    expect((err as SqlColumnError).receivedType).toBe("number");
    expect((err as SqlColumnError).message).toContain("(number)");
  });
});

describe("writing", () => {
  test("a value in the set passes through", () => {
    expect(jobWaits.status.mapToDriverValue("pending")).toBe("pending");
  });

  test("a laundered value throws at the writer, with write-side advice", () => {
    let err: unknown;
    try {
      jobWaits.status.mapToDriverValue("running" as never);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SqlColumnError);
    const e = err as SqlColumnError;
    expect(e.direction).toBe("write");
    expect(e.message).toContain("encoding a value for Postgres");
    // The write-side advice is the opposite of the read-side advice: parse at
    // the boundary that produced the value, do not widen the column.
    expect(e.message).toContain("Parse it at that boundary");
  });
});

describe("a tolerant schema", () => {
  const seen: unknown[] = [];
  const StoredStatusSchema = tolerantEnum(JobWaitStatusSchema, {
    fallback: "pending",
    onFallback: (raw) => seen.push(raw),
  });
  const legacy = pgTable("legacy_waits", {
    status: parsedText("status", StoredStatusSchema).notNull(),
  });

  test("normalizes an out-of-set row and reports it, instead of throwing", () => {
    expect(legacy.status.mapFromDriverValue("waiting")).toBe("pending");
    expect(seen).toEqual(["waiting"]);
  });

  test("leaves a valid value alone and reports nothing", () => {
    const before = seen.length;
    expect(legacy.status.mapFromDriverValue("cancelled")).toBe("cancelled");
    expect(seen.length).toBe(before);
  });
});
