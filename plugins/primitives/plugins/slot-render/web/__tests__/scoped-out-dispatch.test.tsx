import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  PluginProvider,
  PluginScope,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { defineDispatchSlot } from "../internal/render-slot";
import {
  scopedOutDispatchSink,
  type ScopedOutDispatchFault,
} from "../internal/scoped-out-dispatch";

afterEach(() => {
  cleanup();
  scopedOutDispatchSink.register(null);
});

// Inside a `<PluginScope>`, a `.Dispatch` that falls back though the page holds
// a contribution for its key — one the scope dropped without its composition
// negating it — renders the fallback AND says so, once.

const Tool = defineDispatchSlot<{ name: string }>({
  key: (p) => p.name,
  fallback: () => <span>generic card</span>,
});

const plugins = [
  {
    id: "dispatch-scope-in",
    description: "in the scope",
    slots: { tool: Tool },
    contributions: [
      Tool({ match: "Bash", component: () => <span>bash</span> }),
    ],
  },
  {
    id: "dispatch-scope-out",
    description: "on the page, out of the scope",
    contributions: [
      Tool({ match: "Read", component: () => <span>read</span> }),
    ],
  },
] as unknown as LoadedPlugin[];

function mount(names: string[], negated?: string[]) {
  const faults: ScopedOutDispatchFault[] = [];
  scopedOutDispatchSink.register((f) => faults.push(f));
  render(
    <PluginProvider plugins={plugins}>
      <PluginScope
        composition={{
          id: `scope-${names.join("-")}-${negated?.join("-") ?? "none"}`,
          home: null,
          plugins: ["dispatch-scope-in"],
          ...(negated ? { negated } : {}),
        }}
      >
        {names.map((name, i) => (
          <Tool.Dispatch key={i} name={name} />
        ))}
      </PluginScope>
    </PluginProvider>,
  );
  return faults;
}

describe(".Dispatch inside a PluginScope", () => {
  it("reports a fallback the page could have served, once per key", () => {
    const faults = mount(["Read", "Read", "Bash"]);
    expect(screen.getAllByText("generic card")).toHaveLength(2);
    expect(screen.getByText("bash")).toBeTruthy();
    expect(faults).toEqual([
      {
        slotId: "dispatch-scope-in.tool",
        key: "Read",
        plugin: "dispatch-scope-out",
        scope: "scope-Read-Read-Bash-none",
      },
    ]);
  });

  it("is silent for a key nothing on the page serves", () => {
    expect(mount(["Grep"])).toEqual([]);
  });

  it("is silent for a plugin the composition negates by name", () => {
    expect(mount(["Read"], ["dispatch-scope-out"])).toEqual([]);
    expect(screen.getByText("generic card")).toBeTruthy();
  });
});
