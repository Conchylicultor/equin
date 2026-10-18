import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearDuress,
  setDuress,
} from "@plugins/infra/plugins/host/plugins/duress/plugins/latch/server";
import { _setLatchDirForTests } from "@plugins/infra/plugins/host/plugins/duress/plugins/latch/server/testing";
import { worktreesDir } from "@plugins/infra/plugins/paths/server";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import {
  declareRuntimeNamespace,
  runtimeNamespace,
} from "@plugins/infra/plugins/runtime-identity/core";
import { resetRuntimeNamespaceForTest } from "@plugins/infra/plugins/runtime-identity/core/testing";
import { readChannelEntries } from "@plugins/primitives/plugins/log-channels/plugins/log-files/server";
import { getChannelIds } from "../../server/internal/registry";
import { handleEmit } from "../../server/internal/handle-emit";

// Hermetic in the two ways that matter: a throwaway worktree name under the real
// SINGULARITY_DIR (the precedent read-channel-json.test.ts sets), removed at the
// end; and the duress latch pointed at a temp dir of its own, so the test can
// never read — or write — the host's real latch.

// The preload already declared one (the checkout), and a redeclare to a
// different value throws — which is the guard doing its job. This suite is the
// one legitimate exception, so it resets first and puts the original back.
const ORIGINAL_WORKTREE = runtimeNamespace();
const worktree = `handle-emit-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
let latchDir: string;
let channelSeq = 0;

beforeAll(() => {
  // The write path resolves the per-worktree logs dir from the runtime namespace.
  resetRuntimeNamespaceForTest();
  declareRuntimeNamespace(asNamespace(worktree));
  latchDir = mkdtempSync(join(tmpdir(), "handle-emit-latch-"));
  _setLatchDirForTests(latchDir);
});

afterAll(() => {
  clearDuress();
  _setLatchDirForTests(null);
  rmSync(latchDir, { recursive: true, force: true });
  rmSync(join(worktreesDir(), worktree), { recursive: true, force: true });
  resetRuntimeNamespaceForTest();
  declareRuntimeNamespace(ORIGINAL_WORKTREE);
});

beforeEach(() => {
  clearDuress();
});

/** A fresh browser-supplied channel id per test — the registry is process-global. */
function nextChannel(): string {
  channelSeq += 1;
  return `emit-probe-${channelSeq}`;
}

function emitRequest(channel: string, lines: string[]): Request {
  return new Request("http://localhost/api/logs/emit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channel,
      lines: lines.map((line) => ({ line, t: Date.now() })),
    }),
  });
}

describe("POST /api/logs/emit", () => {
  test("ingests the batch when the host is healthy", async () => {
    const channel = nextChannel();
    const res = await handleEmit(emitRequest(channel, ["a", "b", "c"]), {});

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "accepted" });
    expect(getChannelIds()).toContain(channel);
    expect(
      readChannelEntries(worktree, channel, 10)?.map((e) => e.line),
    ).toEqual(["a", "b", "c"]);
  });

  test("answers paused with a 200 while the duress latch is set, touching nothing", async () => {
    const channel = nextChannel();
    setDuress("test");
    const res = await handleEmit(emitRequest(channel, ["dropped"]), {});

    // A 200 is asserted as a LITERAL on purpose. The browser prints "Failed to
    // load resource" for every non-2xx, and the endpoint-error reporter files a
    // crash report for every 5xx — an error status here would either fill the
    // console for the whole duress episode or set off a report storm.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "paused", reason: "duress" });
    // Nothing downstream ran: no channel opened, nothing on disk.
    expect(getChannelIds()).not.toContain(channel);
    expect(readChannelEntries(worktree, channel, 10)).toBeNull();
  });

  test("resumes ingesting once the latch clears", async () => {
    const channel = nextChannel();
    setDuress("test");
    expect(
      await (await handleEmit(emitRequest(channel, ["x"]), {})).json(),
    ).toEqual({ status: "paused", reason: "duress" });

    clearDuress();
    expect(
      await (await handleEmit(emitRequest(channel, ["x"]), {})).json(),
    ).toEqual({ status: "accepted" });
    expect(
      readChannelEntries(worktree, channel, 10)?.map((e) => e.line),
    ).toEqual(["x"]);
  });
});
