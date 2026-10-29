import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { narrowingFixture } from "../core";
import { handleNarrowingFixture } from "./internal/narrowing-fixture";
import { resourcesDebugServed } from "./internal/resources-debug";

export default {
  description:
    "Serves resources.debug: the resource runtime's per-resource debug payload (policy, read-set, routes, relation reads, drift, subscribers, loader and notify counters, declared freshness) as one snapshot value every live-state debug pane reads. Also the worktree-only narrowing fixture (POST /api/debug/read-set/narrowing-fixture, refused on main): creates, re-sessions, moves and deletes a fixture conversation — never a real one — for the network/live narrowing measurement.",
  httpRoutes: {
    [narrowingFixture.route]: handleNarrowingFixture,
  },
  contributions: [...resourcesDebugServed.declare],
} satisfies ServerPluginDefinition;
