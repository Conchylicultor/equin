/**
 * Renaming / recolouring a vocabulary tag is a predicted write: the
 * vocabulary row reads the new name and colour from the call, before the
 * server has answered, and the name is sent as the server will store it.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { act, renderHook, waitFor } from "@testing-library/react";
import { fakeFetchEndpoint } from "@plugins/infra/plugins/endpoints/web/testing";
import { useLiveMutation, useLiveRow } from "@plugins/network/plugins/live/web";
import { queryKeyFor } from "@plugins/primitives/plugins/live-state/web";
import { createLiveStateHarness } from "@plugins/primitives/plugins/live-state/web/testing";
import { pageTagVocabulary } from "../../core";
import { updatePageTag } from "../../shared/endpoints";

const ID = "tag-predicted";

describe("updatePageTag is predicted", () => {
  it("the tag row reads the new name and colour before the answer", async () => {
    let resolve!: (v: unknown) => void;
    const answer = new Promise<unknown>((res) => {
      resolve = res;
    });
    const fake = fakeFetchEndpoint(() => answer);
    const live = createLiveStateHarness({ transport: fake.transport });
    live.queryClient.setQueryData(
      queryKeyFor(pageTagVocabulary.rows.key, { ids: ID }),
      [{ id: ID, name: "Old", color: "gray", createdAt: new Date(0) }],
    );
    const hook = renderHook(
      () => ({
        row: useLiveRow(pageTagVocabulary, ID),
        update: useLiveMutation(updatePageTag),
      }),
      { wrapper: live.Wrapper },
    );
    const tag = () => {
      const r = hook.result.current.row;
      if (r.status !== "ready" || !r.found) throw new Error("not ready");
      return r.row;
    };
    expect(tag().name).toBe("Old");
    act(() => {
      hook.result.current.update.mutate({
        params: { tagId: ID },
        body: { name: "New  name", color: "red" },
      });
    });
    expect(tag()).toMatchObject({ name: "New name", color: "red" });
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    expect(fake.calls[0]!.route).toBe(updatePageTag.route);
    await act(async () => {
      resolve(undefined);
      await answer;
    });
    expect(tag()).toMatchObject({ name: "New name", color: "red" });
  });
});
