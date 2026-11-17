#!/usr/bin/env bun
// The agent process's entry point (`AGENT_SCRIPT`): hold the checkout it runs
// from shared, then load the agent proper. The hold must come FIRST — every
// static import of `./agent.ts` is read before any of its statements runs —
// so this file loads nothing but the hold (`./agent-boot-lease`, light by
// construction: main-slots' boot-lease leaf) before the dynamic import.
// `./agent.ts` releases it once its own imports are in.
import { holdAgentBootLeaseSync } from "./agent-boot-lease";

holdAgentBootLeaseSync();
await import("./agent");
