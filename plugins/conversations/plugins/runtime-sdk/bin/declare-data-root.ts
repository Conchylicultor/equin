import { declareDataRootLayoutSync } from "@plugins/infra/plugins/paths/plugins/data-root-layout/core";

// ── Before anything reads a path: decide where the data root is ──────────────
//
// An SDK agent is the root of its own process tree: the backend starts it under
// `env -i` with the agent session's allowlist (agent-launch's
// `agentSessionEnv`), which carries no data-root declaration, and it outlives
// the backend that started it. So it decides the layout from the disk itself,
// first thing, and every process below it — the claude it runs, that claude's
// hooks and `./equin` calls — inherits the answer through `claudeSessionEnv`'s
// copy of this process's environment (infra/paths CLAUDE.md, § The data root).
// A blocking read, once, before the agent opens its socket.
declareDataRootLayoutSync();
