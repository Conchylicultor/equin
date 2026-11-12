import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { defineRefReaction } from "@plugins/infra/plugins/git/plugins/git-watcher/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { CheckoutDigestsSchema } from "@plugins/framework/plugins/cli/plugins/test/plugins/record/core";
import {
  TEST_DIGEST_GENERATION_ID,
  testDigestGeneration,
  type DigestGeneration,
} from "../../core";
import {
  _testCheckoutDigests,
  _testDigestGeneration,
  recomputeFileStatus,
  testDigestsSettled,
} from "../../server";
import { testDigestsDir } from "../../data-dirs";

const digestsLog = defineLogSink({
  id: "tests-digests",
  description:
    "Test-status page: each computation of the checkout's test digests (`./equin test-digest`) and what it found.",
});

const CHUNK = 500;

/** Where this backend's child writes the digests (`<namespace>.json`). */
function digestsFile(): string {
  return testDigestsDir.file(`${runtimeNamespace()}.json`);
}

/**
 * The checkout's test digests, recomputed when its tree moved: a supervised
 * `./equin test-digest` child (the module graph and the record store stay in
 * the CLI's closure, never the backend's — the type-check backstop's
 * pattern), whose output replaces `test_checkout_digests` and the generation
 * row in one transaction, then re-derives every file's status. The child
 * compares the tree itself (`--unless-tree`): a page opened on an unchanged
 * tree costs one tree hash. At most one runs at a time (the built-in ledger's
 * job-wide lock); a request landing while one runs is answered by it.
 */
export const checkoutDigestsJob = defineSupervisedJob({
  name: "tests.checkout-digests",
  description:
    "Computes every test file's digest for this checkout when its code changed and the Debug → Tests page is open, so harvested verdicts can be matched against the current code.",
  input: z.object({ unlessTree: z.string().nullable() }),
  channel: digestsLog,
  runAttempts: 1,
  argv: (input) => ({
    argv: [
      `./${CLI_NAME}`,
      "test-digest",
      "--out",
      digestsFile(),
      ...(input.unlessTree === null ? [] : ["--unless-tree", input.unlessTree]),
    ],
    cwd: REPO_ROOT,
  }),
  onEnded: async (_runId, terminal) => {
    if (terminal.exitCode !== 0) {
      await setGeneration({
        state: "failed",
        computingSince: null,
        error: `./${CLI_NAME} test-digest exited ${terminal.exitCode}${terminal.signalCode ? ` (${terminal.signalCode})` : ""} — see the tests-digests log`,
      });
      await testDigestsSettled.emit({ outcome: "failed" });
      return;
    }
    const out = CheckoutDigestsSchema.parse(
      JSON.parse(await readFile(digestsFile(), "utf8")),
    );
    if (out.kind === "unchanged") {
      await setGeneration({
        state: "ready",
        computingSince: null,
        error: null,
      });
      await testDigestsSettled.emit({ outcome: "unchanged" });
      return;
    }
    await db.transaction(async (tx) => {
      await tx.delete(_testCheckoutDigests);
      for (let i = 0; i < out.files.length; i += CHUNK)
        await tx.insert(_testCheckoutDigests).values(
          out.files.slice(i, i + CHUNK).map((f) => ({
            path: f.path,
            digest: f.digest,
            runner: f.runner,
            pluginId: f.pluginId,
            generation: out.treeHash,
          })),
        );
      await upsertGeneration(tx, {
        state: "ready",
        generation: out.treeHash,
        headSha: out.head,
        computedAt: new Date(out.computedAt),
        computingSince: null,
        fileCount: out.files.length,
        elapsedMs: out.elapsedMs,
        error: null,
      });
      await recomputeFileStatus(tx, "all");
    });
    await testDigestsSettled.emit({ outcome: "computed" });
  },
});

type GenerationRow = typeof _testDigestGeneration.$inferInsert;
type Exec = Parameters<typeof recomputeFileStatus>[0];

async function upsertGeneration(
  exec: Exec,
  set: Partial<Omit<GenerationRow, "id">>,
): Promise<void> {
  await exec
    .insert(_testDigestGeneration)
    .values({
      id: TEST_DIGEST_GENERATION_ID,
      state: "computing",
      fileCount: 0,
      ...set,
    })
    .onConflictDoUpdate({ target: _testDigestGeneration.id, set });
}

function setGeneration(set: Partial<Omit<GenerationRow, "id">>): Promise<void> {
  return upsertGeneration(db, set);
}

async function readGenerationRow() {
  const [row] = await db
    .select()
    .from(_testDigestGeneration)
    .where(eq(_testDigestGeneration.id, TEST_DIGEST_GENERATION_ID));
  return row ?? null;
}

/**
 * Ask for the digests to be brought up to this checkout's tree: mark the row
 * (computing when there is no generation yet; otherwise a check in flight)
 * and enqueue the job. Cheap and idempotent — the child decides.
 */
export async function requestCheckoutDigests(): Promise<void> {
  const row = await readGenerationRow();
  await setGeneration({
    state: row?.generation ? row.state : "computing",
    computingSince: new Date(),
  });
  await checkoutDigestsJob.enqueue({ unlessTree: row?.generation ?? null });
}

// How many tuples of the generation value are subscribed: the digests are
// kept current only while someone reads them (the page is open).
let watchers = 0;

export const digestGenerationServed = serveValue(testDigestGeneration, {
  source: "db",
  reads: {
    tables: [_testDigestGeneration],
    reason: "the page's generation line reads the one generation row",
  },
  loader: async (): Promise<DigestGeneration> => {
    const row = await readGenerationRow();
    if (row === null)
      return {
        state: "none",
        generation: null,
        headSha: null,
        computedAt: null,
        computingSince: null,
        fileCount: 0,
        elapsedMs: null,
        error: null,
      };
    return {
      state: row.state,
      generation: row.generation,
      headSha: row.headSha,
      computedAt: row.computedAt?.toISOString() ?? null,
      computingSince: row.computingSince?.toISOString() ?? null,
      fileCount: row.fileCount,
      elapsedMs: row.elapsedMs,
      error: row.error,
    };
  },
  whileSubscribed: () => {
    watchers++;
    void requestCheckoutDigests();
    return () => {
      watchers--;
    };
  },
});

/** Main moved while the page is open: its digests may have too. */
export const digestsOnMainAdvance = defineRefReaction({
  name: "tests.checkout-digests",
  refName: "refs/heads/main",
  run: async () => {
    if (watchers > 0) await requestCheckoutDigests();
  },
});
