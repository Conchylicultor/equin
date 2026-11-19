import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAppliedQuery } from "../internal/use-applied-query";

// The search split: the field shows the query as typed, the rows get it
// applied a deferred render later — and the applied state keeps the stored
// state's identity rules, so memos downstream hold.

interface State {
  query: string;
  sort: readonly string[];
}

const base: State = { query: "", sort: [] };

describe("useAppliedQuery", () => {
  it("applies the typed query, and hands back the stored state itself when it already holds it", () => {
    const { result, rerender } = renderHook(
      ({ stored }: { stored: State }) => useAppliedQuery(stored, undefined),
      { initialProps: { stored: base } },
    );
    expect(result.current.state).toBe(base);
    const typed = { ...base, query: "pa" };
    act(() => rerender({ stored: typed }));
    expect(result.current.typed).toBe("pa");
    expect(result.current.state).toBe(typed);
  });

  it("a controlled query replaces the stored one; the state keeps one identity while nothing moves", () => {
    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useAppliedQuery(base, q),
      { initialProps: { q: "pa" } },
    );
    const first = result.current.state;
    expect(first).toEqual({ query: "pa", sort: [] });
    act(() => rerender({ q: "pa" }));
    expect(result.current.state).toBe(first);
    act(() => rerender({ q: "par" }));
    expect(result.current.typed).toBe("par");
    expect(result.current.state).toEqual({ query: "par", sort: [] });
  });

  it("an edit other than the query is applied with the query in effect", () => {
    const { result, rerender } = renderHook(
      ({ stored }: { stored: State }) => useAppliedQuery(stored, "pa"),
      { initialProps: { stored: base } },
    );
    const sorted = { ...base, sort: ["name"] };
    act(() => rerender({ stored: sorted }));
    expect(result.current.state).toEqual({ query: "pa", sort: ["name"] });
  });
});

describe("useAppliedQuery across views", () => {
  it("another view's state is drawn with its own query, never the previous view's", () => {
    const a: State = { query: "foo", sort: [] };
    const b: State = { query: "", sort: ["name"] };
    const seen: string[] = [];
    const { result, rerender } = renderHook(
      ({ stored }: { stored: State }) => {
        const r = useAppliedQuery(stored, undefined);
        seen.push(`${r.state.sort.join()}:${r.state.query}`);
        return r;
      },
      { initialProps: { stored: a } },
    );
    seen.length = 0;
    act(() => rerender({ stored: b }));
    expect(result.current.state).toBe(b);
    expect(
      seen.filter((s) => s.startsWith("name:")).every((s) => s === "name:"),
    ).toBe(true);
  });
});
