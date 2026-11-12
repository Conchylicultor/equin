import { expect, test, describe } from "bun:test";
import type { StallSection } from "@plugins/debug/plugins/trace/plugins/stall/core";
import { deriveCulprit, NO_JS_IN_BLOCK } from "./culprit";

describe("deriveCulprit", () => {
  test("labels the DOMINANT stack, not a cold attributable leaf (regression)", () => {
    // The real report this fix exists for: a `spawn`-rooted freeze at 46.7% of
    // samples was titled `is @ .../drizzle-orm/entity.js:7` — 1 of 15 samples,
    // unrelated to the freeze — because the old scan filtered `topLeaves` for
    // ` @ `, skipped the unattributed-but-dominant native `spawn`, and landed on
    // an arbitrary cold tie.
    const section: StallSection = {
      nSamples: 15,
      sampleRateHz: 5,
      topLeaves: [
        { key: "spawn [Unknown Executable]", count: 7, pct: 46.7 },
        { key: "is @ node_modules/drizzle-orm/entity.js:7", count: 1, pct: 6.7 },
      ],
      topStacks: [
        {
          stack: "spawn ← listPanes ← listPanes ← list ← list ← collectLive",
          count: 7,
          pct: 46.7,
          frames: [
            "spawn [Unknown Executable]",
            "listPanes @ plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts:499",
            "listPanes @ plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts:512",
            "list @ plugins/conversations/server/internal/poller.ts:120",
            "list @ plugins/conversations/server/internal/poller.ts:141",
            "collectLive @ plugins/conversations/server/internal/poller.ts:288",
          ],
        },
      ],
    };
    const { culpritStack, hotFrame } = deriveCulprit(section);
    // Fingerprint stability: unchanged, verbatim topStacks[0].stack.
    expect(culpritStack).toBe("spawn ← listPanes ← listPanes ← list ← list ← collectLive");
    // The label names what burned samples (`spawn`) and where it was called from.
    expect(hotFrame).toBe(
      "spawn ← listPanes @ plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts:499",
    );
    // The whole point: the cold 1-sample leaf never reaches the title.
    expect(hotFrame).not.toContain("drizzle");
  });

  test("fingerprints on the caller STACK, and labels via that stack's own frames", () => {
    // The Jul-7 shape: the hottest leaf is a generic native frame shared by every
    // JSON caller, but the top stack names the actual caller path.
    const section: StallSection = {
      nSamples: 1000,
      sampleRateHz: 230,
      topLeaves: [
        { key: "JSON.parse [native]", count: 700, pct: 70 },
        { key: "parseTranscript @ plugins/ccusage/parse.ts:42", count: 200, pct: 20 },
      ],
      topStacks: [
        {
          stack: "parseTranscript ← readEntries ← run",
          count: 650,
          pct: 65,
          frames: [
            "JSON.parse [native]",
            "parseTranscript @ plugins/ccusage/parse.ts:42",
            "readEntries @ plugins/ccusage/parse.ts:88",
            "run @ plugins/ccusage/run.ts:12",
          ],
        },
        { stack: "flushNotifies ← tick", count: 150, pct: 15 },
      ],
    };
    const { culpritStack, hotFrame } = deriveCulprit(section);
    // Fingerprint grain is the caller stack, never the native leaf.
    expect(culpritStack).toBe("parseTranscript ← readEntries ← run");
    // The Jul-7 intent is preserved — `parseTranscript` still surfaces — but now
    // prefixed with the native leaf that actually burned the samples.
    expect(hotFrame).toBe("JSON.parse ← parseTranscript @ plugins/ccusage/parse.ts:42");
  });

  test("an already-attributable leaf is returned bare, with no redundant prefix", () => {
    const section: StallSection = {
      nSamples: 500,
      sampleRateHz: 230,
      topLeaves: [
        { key: "compileTemplate @ plugins/story/render.ts:88", count: 400, pct: 80 },
        { key: "memcpy [native]", count: 50, pct: 10 },
      ],
      topStacks: [
        {
          stack: "compileTemplate ← renderPage ← handle",
          count: 400,
          pct: 80,
          frames: [
            "compileTemplate @ plugins/story/render.ts:88",
            "renderPage @ plugins/story/render.ts:140",
            "handle @ plugins/story/server/routes.ts:20",
          ],
        },
      ],
    };
    const { culpritStack, hotFrame } = deriveCulprit(section);
    expect(culpritStack).toBe("compileTemplate ← renderPage ← handle");
    expect(hotFrame).toBe("compileTemplate @ plugins/story/render.ts:88");
    expect(hotFrame).not.toContain("←");
  });

  test("an all-native stack falls back to the bare leaf key", () => {
    const section: StallSection = {
      nSamples: 20,
      sampleRateHz: 5,
      topLeaves: [{ key: "spawn [Unknown Executable]", count: 18, pct: 90 }],
      topStacks: [
        {
          stack: "spawn ← ? ← ?",
          count: 18,
          pct: 90,
          frames: ["spawn [Unknown Executable]", "? [native]", "? [native]"],
        },
      ],
    };
    const { culpritStack, hotFrame } = deriveCulprit(section);
    expect(culpritStack).toBe("spawn ← ? ← ?");
    expect(hotFrame).toBe("spawn [Unknown Executable]");
  });

  test("back-compat: a stack persisted without `frames` falls back to topLeaves[0]", () => {
    const section: StallSection = {
      nSamples: 1000,
      sampleRateHz: 230,
      topLeaves: [
        { key: "JSON.parse [native]", count: 700, pct: 70 },
        { key: "parseTranscript @ plugins/ccusage/parse.ts:42", count: 200, pct: 20 },
      ],
      topStacks: [{ stack: "parseTranscript ← readEntries ← run", count: 650, pct: 65 }],
    };
    const { culpritStack, hotFrame } = deriveCulprit(section);
    expect(culpritStack).toBe("parseTranscript ← readEntries ← run");
    expect(hotFrame).toBe("JSON.parse [native]");
  });

  test("empty section falls back without throwing", () => {
    const section: StallSection = {
      nSamples: 0,
      sampleRateHz: 0,
      topLeaves: [],
      topStacks: [],
    };
    expect(() => deriveCulprit(section)).not.toThrow();
    expect(deriveCulprit(section)).toEqual({
      culpritStack: "unknown",
      hotFrame: "event-loop stall",
    });
  });

  test("a block with no sample in it is its own named finding", () => {
    const section: StallSection = {
      nSamples: 0,
      sampleRateHz: 0,
      scope: "block",
      spanMs: 2856,
      topLeaves: [],
      topStacks: [],
    };
    expect(deriveCulprit(section).culpritStack).toBe(NO_JS_IN_BLOCK);
    expect(deriveCulprit(section).hotFrame).toContain(NO_JS_IN_BLOCK);
  });
});
