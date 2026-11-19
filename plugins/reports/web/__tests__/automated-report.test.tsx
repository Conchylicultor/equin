// A report an automated browser files (an agent driving the page, an e2e run)
// says so first, through whichever channel the page sends by — marked, never
// muted (scope/automation).

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReportBody } from "../../core";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@plugins/primitives/plugins/scope/plugins/automation/web");
});

async function sent(automated: boolean): Promise<ReportBody> {
  vi.doMock(
    "@plugins/primitives/plugins/scope/plugins/automation/web",
    async (importOriginal) => ({
      ...(await importOriginal<object>()),
      AUTOMATED_BROWSER: automated,
    }),
  );
  const { report, reportChannel } = await import("../report");
  const bodies: ReportBody[] = [];
  reportChannel.register(async (body) => {
    bodies.push(body);
    return { outcome: "batched" };
  });
  await report({
    kind: "render-loop",
    source: "client-render-loop",
    message: "Render loop: noop-attr @ 45/s",
    data: {},
  });
  expect(bodies).toHaveLength(1);
  return bodies[0]!;
}

describe("report() from an automated browser", () => {
  it("opens the message with the mark", async () => {
    expect((await sent(true)).message).toBe(
      "(automated browser) Render loop: noop-attr @ 45/s",
    );
  });

  it("leaves a visitor's message as it is", async () => {
    expect((await sent(false)).message).toBe("Render loop: noop-attr @ 45/s");
  });
});
