import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { writeAllSync } from "./internal/write-all";

export default {
  description:
    "writeAllSync(fd, data): every byte written before it returns, on a blocking or a NON-blocking fd alike — a full non-blocking pipe (EAGAIN) is waited out with poll(2) until the reader drains it, never spun on, dropped or swallowed. Bun turns a piped stdout non-blocking the first time process.stdout is touched, so a synchronous writer to fd 1 or 2 (`./equin build | tail`) must use this, not a bare writeSync.",
} satisfies MachinePluginDefinition;
