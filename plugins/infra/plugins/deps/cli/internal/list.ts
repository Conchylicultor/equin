import type { CliAction } from "@plugins/framework/plugins/cli/core";
import type { DepState } from "../../core";
import { declaredDeps, depState, heldDep } from "../../deps";

function describe(state: DepState): string {
  switch (state.kind) {
    case "absent":
      return "absent";
    case "installing":
      return `installing since ${state.since}`;
    case "ready":
      return `ready ${state.identity} ${(state.bytes / 1e6).toFixed(1)} MB, last used ${state.lastUsed ?? "never"}`;
    case "failed":
      return `failed at ${state.at}: ${state.message.split("\n")[0]}`;
  }
}

// No backend boot: the declarations are a generated registry, read directly.
const run: CliAction<[], object> = async () => {
  const deps = await declaredDeps();
  if (deps.length === 0) {
    console.log("No dependency is declared in this checkout.");
    return;
  }
  for (const dep of deps) {
    const state = await depState(dep);
    console.log(
      `${dep.id}  [${dep.source.kind}: ${dep.source.label}]  ${dep.sizeHint}\n  ${describe(state)}`,
    );
    if (dep.pin !== null) {
      const held = await heldDep(dep, dep.pin.holder);
      console.log(
        held.kind === "held"
          ? `  pinned ${held.ready.identity} — what runs; \`./equin deps pin ${dep.id}\` switches it to this checkout's`
          : `  nothing pinned yet — the first start pins this checkout's install`,
      );
    }
  }
};

export default run;
