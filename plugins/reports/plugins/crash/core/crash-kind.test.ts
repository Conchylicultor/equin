/**
 * The crash fingerprint's three-branch identity rule
 * (research/2026-09-18-reports-stackless-fingerprint-and-crash-realert.md).
 *
 * Two halves are pinned here. The regression half: a report with no stack and
 * no error type used to hash the constant `Error|`, so every one of them landed
 * on a single row — on main, 499 unrelated occurrences. The migration-free
 * half: the literal hashes below were computed from the PREVIOUS implementation
 * and must not move, because a changed fingerprint means an existing report row
 * is orphaned and its history starts over.
 *
 * Run: `./equin test plugins/reports`
 */

import { describe, test, expect } from "bun:test";
import { crashFingerprint, normalizeMessage } from "./crash-kind";

const ctx = (message: string) => ({ message, source: "browser-error" });

// A V8 stack, with the cache-buster / vite-deps / @fs forms normalization
// strips — so the fingerprint survives a dev reload.
const V8_STACK = [
  "TypeError: Cannot read properties of undefined (reading 'id')",
  "    at TaskRow (https://singularity.localhost:9000/@fs/src/task-row.tsx?v=abc123:41:17)",
  "    at renderWithHooks (https://singularity.localhost:9000/node_modules/.vite/deps/react-dom.js:12345:26)",
  "    at mountIndeterminateComponent (https://singularity.localhost:9000/node_modules/.vite/deps/react-dom.js:99:3)",
  "    at beginWork (https://singularity.localhost:9000/node_modules/.vite/deps/react-dom.js:7:1)",
].join("\n");

// The same crash as Safari/Firefox spell it: `fn@location`, no "at".
const SAFARI_STACK = [
  "TaskRow@https://singularity.localhost:9000/src/task-row.tsx:41:17",
  "renderWithHooks@https://singularity.localhost:9000/src/react-dom.js:12345:26",
  "@https://singularity.localhost:9000/src/main.tsx:3:9",
].join("\n");

describe("crashFingerprint", () => {
  test("two stackless, typeless messages no longer collapse onto one identity", async () => {
    const a = await crashFingerprint(
      {},
      ctx("ResizeObserver loop completed with undelivered notifications."),
    );
    const b = await crashFingerprint(
      {},
      ctx('[jobs] reclaimed serialization queue "conv-1789653369-gpuv"'),
    );

    expect(a).not.toBe(b);
    // And neither is the old catch-all bucket, whose row keeps its history.
    expect(a).not.toBe("fd09132174a7869f");
    expect(b).not.toBe("fd09132174a7869f");
  });

  test("one recurring problem stays one identity across its varying ids and numbers", async () => {
    const first = await crashFingerprint(
      {},
      ctx("[jobs] reclaimed stuck lock for conv-1789653369-gpuv (job 12345)"),
    );
    const second = await crashFingerprint(
      {},
      ctx("[jobs] reclaimed stuck lock for conv-1789999999-zzzz (job 98)"),
    );

    expect(first).toBe(second);
  });

  test("a stack's frames are the identity — pinned, so existing rows keep theirs", async () => {
    expect(
      await crashFingerprint(
        { errorType: "TypeError", stack: V8_STACK },
        ctx("boom"),
      ),
    ).toBe("406bada5c34f165b");
    // The message is NOT part of a framed crash's identity: two occurrences of
    // one bug carry different messages.
    expect(
      await crashFingerprint(
        { errorType: "TypeError", stack: V8_STACK },
        ctx("a different message"),
      ),
    ).toBe("406bada5c34f165b");
  });

  test("a caller-declared errorType with no stack keeps its identity — pinned", async () => {
    // The deliberate collapse: a family of varying messages onto one row.
    expect(
      await crashFingerprint(
        { errorType: "LiveStateWedge:missed-updates" },
        ctx("one"),
      ),
    ).toBe("1869d2fb082af3b0");
    expect(
      await crashFingerprint(
        { errorType: "LiveStateWedge:missed-updates", stack: null },
        ctx("another"),
      ),
    ).toBe("1869d2fb082af3b0");
    expect(
      await crashFingerprint({ errorType: "PaneRestoreCorrupt" }, ctx("x")),
    ).toBe("e35e378d23f0928b");
  });

  test("a Safari-form stack yields frames instead of falling through to the message", async () => {
    const safari = await crashFingerprint(
      { errorType: "TypeError", stack: SAFARI_STACK },
      ctx("boom"),
    );

    // Before, none of those lines parsed as a frame, so the whole stack was
    // discarded and every Safari crash of this type shared `TypeError|`.
    const typeOnly = await crashFingerprint(
      { errorType: "TypeError" },
      ctx("boom"),
    );
    expect(safari).not.toBe(typeOnly);
    expect(typeOnly).toBe("3f502e923ffbe2dc");

    // Two Safari crashes at different lines of the same functions are one bug.
    const sameBug = await crashFingerprint(
      {
        errorType: "TypeError",
        stack: SAFARI_STACK.replace(":41:17", ":58:4"),
      },
      ctx("boom"),
    );
    expect(sameBug).toBe(safari);
  });
});

describe("normalizeMessage", () => {
  test("replaces the tokens that vary between occurrences of one problem", () => {
    expect(normalizeMessage("conv-1789653369-gpuv timed out")).toBe(
      "<id> timed out",
    );
    expect(normalizeMessage("worktree att-1789665345-p1mc gone")).toBe(
      "worktree <id> gone",
    );
    expect(
      normalizeMessage("run 3f2504e0-4f89-11d3-9a0c-0305e82c3301 failed"),
    ).toBe("run <uuid> failed");
    expect(normalizeMessage("commit 9ffecc9b3a1d2e4f is stale")).toBe(
      "commit <hex> is stale",
    );
    expect(normalizeMessage("job 12345 exceeded 30s")).toBe(
      "job # exceeded #s",
    );
    expect(normalizeMessage("a\n  b\tc  ")).toBe("a b c");
  });

  test("keeps two genuinely different problems apart, and stays bounded", () => {
    expect(normalizeMessage("queue A wedged")).not.toBe(
      normalizeMessage("queue B wedged"),
    );
    expect(normalizeMessage("x".repeat(5_000)).length).toBe(200);
  });
});
