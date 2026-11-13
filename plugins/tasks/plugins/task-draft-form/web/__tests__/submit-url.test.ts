/**
 * The filed URL: a card attaches the draft page's URL when its toggle (or the
 * app's default) says so — and never when the draft is about no page.
 */
import { describe, expect, it } from "vitest";
import type { FetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import type { TaskChainSubmitBody } from "@plugins/tasks/core";
import { submitChain } from "../internal/submit";

async function filedUrls(
  url: string | null,
  includeUrl: boolean | undefined,
  captureUrlDefault: boolean,
): Promise<(string | undefined)[]> {
  let body: TaskChainSubmitBody | undefined;
  const fetchEndpoint = (async (_e: unknown, _p: unknown, init: unknown) => {
    body = (init as { body: TaskChainSubmitBody }).body;
    return { taskIds: ["task-1"] };
  }) as unknown as FetchEndpoint;
  const outcome = await submitChain(fetchEndpoint, {
    cards: [
      {
        localId: "a",
        text: "fix it",
        options: {},
        includeUrl,
        linkedToPrev: false,
      },
    ],
    target: { kind: "root" },
    relate: undefined,
    url,
    captureUrlDefault,
    options: [],
  });
  expect(outcome.ok).toBe(true);
  return body!.cards.map((c) => c.url);
}

describe("submitChain's URL", () => {
  it("attaches the page's URL when the card's toggle is on", async () => {
    expect(await filedUrls("http://x/", true, false)).toEqual(["http://x/"]);
  });

  it("follows the app's default while the toggle was never touched", async () => {
    expect(await filedUrls("http://x/", undefined, true)).toEqual([
      "http://x/",
    ]);
    expect(await filedUrls("http://x/", undefined, false)).toEqual([undefined]);
  });

  it("attaches nothing for a draft about no page, whatever the toggle", async () => {
    expect(await filedUrls(null, true, true)).toEqual([undefined]);
  });
});
