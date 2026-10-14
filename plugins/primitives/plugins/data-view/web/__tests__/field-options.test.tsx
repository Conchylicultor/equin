/**
 * A field presented with `useOptions` (`FieldPresentation.Register`, a live
 * option read — a model catalog) gets its options as a READ: pending, with
 * `optionsResult` loading, until the read settles, then the options as its
 * own — never a stand-in empty list — and its declared options give way to
 * the read ones.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, act } from "@testing-library/react";
import { useSyncExternalStore, type ReactElement } from "react";
import type { LiveFieldOptionsRead } from "@plugins/network/plugins/live/web";
import type { FieldDef } from "../../core";
import { CollectFieldOptions } from "../internal/derived-fields";

afterEach(cleanup);

const refetch = () => Promise.resolve();
let current: LiveFieldOptionsRead = { status: "loading", refetch };
const listeners = new Set<() => void>();
const publish = (next: LiveFieldOptionsRead) => {
  current = next;
  for (const l of listeners) l();
};
function useModelOptions(): LiveFieldOptionsRead {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => current,
  );
}

const fields: FieldDef<unknown>[] = [
  { id: "title", label: "Title" },
  {
    id: "model",
    label: "Model",
    type: "text",
    options: [{ value: "stale", label: "Stale" }],
  },
];

function Probe(): ReactElement {
  return (
    <CollectFieldOptions
      readers={[{ id: "model", useOptions: useModelOptions }]}
      fields={fields}
    >
      {(out) => {
        const model = out.find((f) => f.id === "model")!;
        return (
          <pre data-testid="model">
            {JSON.stringify({
              type: model.type,
              options: model.options ?? null,
              result: model.optionsResult ?? null,
              pending: model.pending ?? false,
              title: out.find((f) => f.id === "title") === fields[0],
            })}
          </pre>
        );
      }}
    </CollectFieldOptions>
  );
}

describe("CollectFieldOptions", () => {
  it("hands the field its live options, pending first, in place of its declared ones", () => {
    render(<Probe />);
    const read = () => JSON.parse(screen.getByTestId("model").textContent!);
    expect(read()).toEqual({
      type: "enum",
      options: null,
      result: { status: "loading" },
      pending: true,
      title: true,
    });
    act(() =>
      publish({
        status: "ready",
        data: [{ value: "opus", label: "Opus", variant: "primary" }],
        refetch,
      }),
    );
    expect(read()).toEqual({
      type: "enum",
      options: [{ value: "opus", label: "Opus", variant: "primary" }],
      result: null,
      pending: false,
      title: true,
    });
  });
});
