/**
 * The crash fingerprint's three-branch identity rule
 * (research/2026-09-18-reports-stackless-fingerprint-and-crash-realert.md).
 *
 * Three things are pinned here. The regression half: a report with no stack
 * and no error type used to hash the constant `Error|`, so every one of them
 * landed on a single row — on main, 499 unrelated occurrences. The stability
 * half: the literal hashes below must not move, because a changed fingerprint
 * means an existing report row is orphaned and its history starts over. And the
 * location-independence half: one crash keeps one identity whichever host,
 * build or checkout it ran from — before, the page's host was hashed in, so a
 * product rename moved every pinned hash and each namespace minted its own row.
 *
 * Run: `./equin test plugins/reports`
 */

import { describe, test, expect } from "bun:test";
import {
  crashFingerprint,
  normalizeFrames,
  normalizeMessage,
} from "./crash-kind";

const ctx = (message: string) => ({ message, source: "browser-error" });

// A V8 stack, with the cache-buster / vite-deps / @fs forms normalization
// strips — so the fingerprint survives a dev reload.
const V8_STACK = [
  "TypeError: Cannot read properties of undefined (reading 'id')",
  "    at TaskRow (https://equin.localhost:9000/@fs/src/task-row.tsx?v=abc123:41:17)",
  "    at renderWithHooks (https://equin.localhost:9000/node_modules/.vite/deps/react-dom.js:12345:26)",
  "    at mountIndeterminateComponent (https://equin.localhost:9000/node_modules/.vite/deps/react-dom.js:99:3)",
  "    at beginWork (https://equin.localhost:9000/node_modules/.vite/deps/react-dom.js:7:1)",
].join("\n");

// The same crash as Safari/Firefox spell it: `fn@location`, no "at".
const SAFARI_STACK = [
  "TaskRow@https://equin.localhost:9000/src/task-row.tsx:41:17",
  "renderWithHooks@https://equin.localhost:9000/src/react-dom.js:12345:26",
  "@https://equin.localhost:9000/src/main.tsx:3:9",
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
    // Re-pinned 2026-11-02 when the origin / content hash / checkout prefix
    // left the frame (research/2026-11-02-reports-host-independent-crash-fingerprint.md);
    // the hash no longer depends on the fixture's host.
    expect(
      await crashFingerprint(
        { errorType: "TypeError", stack: V8_STACK },
        ctx("boom"),
      ),
    ).toBe("2b8fe9edd20f4851");
    // The message is NOT part of a framed crash's identity: two occurrences of
    // one bug carry different messages.
    expect(
      await crashFingerprint(
        { errorType: "TypeError", stack: V8_STACK },
        ctx("a different message"),
      ),
    ).toBe("2b8fe9edd20f4851");
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

describe("a frame's location is not its identity", () => {
  const fp = (stack: string) =>
    crashFingerprint({ errorType: "TypeError", stack }, ctx("boom"));

  test("the host serving the page — namespace, alias, renamed product", async () => {
    const pinned = await fp(V8_STACK);
    // Any origin at all: another namespace, main's alias, the host main
    // answered on before the product rename, a dev server.
    for (const host of [
      "http://att-1793641754-xwb5vn.localhost:9000",
      "http://127.0.0.1:9000",
      "http://localhost:5173",
      "https://app.example.com",
    ]) {
      expect(
        await fp(V8_STACK.replaceAll("https://equin.localhost:9000", host)),
      ).toBe(pinned);
    }
  });

  test("the content hash of the build that served it", async () => {
    const built = (hash: string) =>
      [
        "Error: boom",
        `    at reject (http://equin.localhost:9000/artifacts/network.live.core.${hash}/index.js:57:9)`,
        `    at http://equin.localhost:9000/artifacts/network.live.web.${hash}/index.js:218:25`,
      ].join("\n");
    expect(await fp(built("5d6e9dbccf632a03"))).toBe(
      await fp(built("e8ef70cea1efca77")),
    );
  });

  test("the checkout a server frame ran from", async () => {
    const ranFrom = (root: string) =>
      [
        "AgentStartError: exited",
        `    at launchAgent (${root}/plugins/conversations/plugins/runtime-sdk/machine/internal/sdk-runtime.ts:383:15)`,
        `    at async <anonymous> (${root}/node_modules/graphile-worker/dist/main.js:12:3)`,
      ].join("\n");
    const main = await fp(ranFrom("/home/a/dev/repo"));
    expect(
      await fp(ranFrom("/home/a/dev/repo/.claude/worktrees/att-1-x")),
    ).toBe(main);
    expect(await fp(ranFrom("file:///home/b/src/equin"))).toBe(main);
  });

  test("the normalized frame is the function and the app-relative file", () => {
    expect(
      normalizeFrames(
        [
          "Error: boom",
          "    at reject (http://equin.localhost:9000/artifacts/network.live.core.5d6e9dbccf632a03/index.js:57:9)",
          "    at http://x.localhost:9000/artifacts/set.0123456789abcdef/react.js:1:2",
          "    at f (http://x.localhost:9000/@fs/home/a/repo/node_modules/.vite/deps/react-dom.js?v=1a2b:3:4)",
          "    at g (/home/a/repo/.claude/worktrees/att-1-x/plugins/p/plugins/q/server/x.ts:5:6)",
          "    at h (http://x.localhost:9000/plugins/p/web/y.tsx?t=123:7:8)",
          "TaskRow@https://equin.localhost:9000/src/task-row.tsx:41:17",
        ].join("\n"),
      ),
    ).toEqual([
      "at reject (/artifacts/network.live.core/index.js",
      "at /artifacts/set/react.js",
      "at f (/NM/react-dom.js",
      "at g (/plugins/p/plugins/q/server/x.ts",
      "at h (/plugins/p/web/y.tsx",
      "TaskRow@/src/task-row.tsx",
    ]);
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
