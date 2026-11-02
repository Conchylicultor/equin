/**
 * Tests for the `no-legacy-resource-spelling` lint rule. The rule module alone
 * flags every file; the substrate and burndown exemptions are
 * `exempt/index.ts` manifests, checked by `exempt:manifests-valid` and the
 * unused-exemption report.
 */

import rule from "./no-legacy-resource-spelling";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const LIVE_STATE_WEB = "@plugins/primitives/plugins/live-state/web";
const SERVER_CORE = "@plugins/framework/plugins/server-core/core";
const CENTRAL_CORE = "@plugins/framework/plugins/central-core/core";
const QUERY_RESOURCE_CORE = "@plugins/infra/plugins/query-resource/core";
const QUERY_RESOURCE_SERVER = "@plugins/infra/plugins/query-resource/server";

/** An error naming `name` (its message starts with the old spelling). */
const legacy = (name: string) => ({
  message: new RegExp(`^\`${name}\` is a legacy live-resource spelling\\.`),
});

ruleTester.run("no-legacy-resource-spelling", rule, {
  valid: [
    // A name the same barrel exports that is not an old spelling.
    { code: `import { matchResource } from "${LIVE_STATE_WEB}";` },
    { code: `import type { ResourceResult } from "${LIVE_STATE_WEB}";` },
    // The unified spellings.
    {
      code: `
          import { useLive, useLiveReader } from "@plugins/network/plugins/live/web";
          import { serveValue } from "@plugins/network/plugins/live/server";
        `,
      },
      // An old name from a barrel that does not export it as the old spelling
      // (`queryResource` was only ever query-resource/server's).
      { code: `import { queryResource } from "${QUERY_RESOURCE_CORE}";` },
      // A relative import — the defining plugins' own, exempt by `ignores`.
      { code: `import { useResource } from "./use-resource";` },
      // A local of the same name, not imported.
      { code: `function useResource() {} useResource();` },
      // A namespace import read for a name that is not an old spelling.
      {
        code: `
          import * as liveState from "${LIVE_STATE_WEB}";
          liveState.matchResource(r, {});
        `,
      },
      // A re-export of a name that is not an old spelling.
      { code: `export { matchResource } from "${LIVE_STATE_WEB}";` },
      // A local that shadows the namespace import is not the module object.
      {
        code: `
          import * as liveState from "${LIVE_STATE_WEB}";
          function read(liveState: { useResource: () => void }) {
            return liveState.useResource();
          }
        `,
      },
      // Destructuring a name that is not an old spelling.
      {
        code: `
          import * as liveState from "${LIVE_STATE_WEB}";
          const { matchResource } = liveState;
        `,
      },
      // An awaited dynamic import read for a name that is not an old spelling.
      {
        code: `
          const liveState = await import("${LIVE_STATE_WEB}");
          liveState.matchResource(r, {});
        `,
      },
      // A dynamic import of a barrel that exports no old spelling.
      {
        code: `
          const live = await import("@plugins/network/plugins/live/web");
          live.useLive(c);
        `,
      },
      // A type position calls nothing.
      {
        code: `
          import type * as liveState from "${LIVE_STATE_WEB}";
          type Read = ReturnType<typeof liveState.useResource>;
        `,
      },
    ],
    invalid: [
      // The flagged import.
      {
        code: `import { useResource } from "${LIVE_STATE_WEB}";`,
        errors: [
          {
            messageId: "legacySpelling",
            data: { name: "useResource", replacement: "`useLive`" },
          },
        ],
      },
      // An aliased import is flagged by its imported name.
      {
        code: `import { defineResource as serve } from "${SERVER_CORE}";`,
        errors: [
          {
            messageId: "legacySpelling",
            data: {
              name: "defineResource",
              replacement: "`serveValue` or `serveCollection`",
            },
          },
        ],
      },
      // One report per old spelling; the other names in the import are fine.
      // Both are deleted from the barrel but stay flagged, so a stale import
      // is told its replacement.
      {
        code: `import { usePointResource, matchResource, useWindowResource } from "${LIVE_STATE_WEB}";`,
        errors: [legacy("usePointResource"), legacy("useWindowResource")],
      },
      // The deleted row hook: one row is a `useLive` query now.
      {
        code: `import { useLive, useLiveRow } from "@plugins/network/plugins/live/web";`,
        errors: [
          {
            messageId: "legacySpelling",
            data: { name: "useLiveRow", replacement: "`useLive(c, { id })`" },
          },
        ],
      },
      // Central's facade exports the same factories.
      {
        code: `import { defineExternalResource } from "${CENTRAL_CORE}";`,
        errors: [legacy("defineExternalResource")],
      },
      // A type-only import still spells the old name.
      {
        code: `import type { windowQueryResourceDescriptor } from "${QUERY_RESOURCE_CORE}";`,
        errors: [legacy("windowQueryResourceDescriptor")],
      },
      // A re-export, plain and aliased.
      {
        code: `export { windowQueryResource, queryResource as q } from "${QUERY_RESOURCE_SERVER}";`,
        errors: [legacy("windowQueryResource"), legacy("queryResource")],
      },
      // The deferred / multi-tuple substrate is a substrate spelling too.
      {
        code: `
          import { defineDeferredResource } from "${SERVER_CORE}";
          import { deferredWindowQueryResource } from "${QUERY_RESOURCE_SERVER}";
          import { useResources } from "${LIVE_STATE_WEB}";
        `,
        errors: [
          legacy("defineDeferredResource"),
          legacy("deferredWindowQueryResource"),
          legacy("useResources"),
        ],
      },
      // A member read off a namespace import, dotted and computed.
      {
        code: `
          import * as liveState from "${LIVE_STATE_WEB}";
          liveState.usePointResources(c, ids);
          liveState["resourceDescriptor"]("k", {});
        `,
        errors: [legacy("usePointResources"), legacy("resourceDescriptor")],
      },
      // Destructured off a namespace import, aliased or not.
      {
        code: `
          import * as liveState from "${LIVE_STATE_WEB}";
          const { useResource: read, matchResource, useWindowResource } = liveState;
        `,
        errors: [legacy("useResource"), legacy("useWindowResource")],
      },
      // Destructured straight off an awaited dynamic import.
      {
        code: `const { defineResource } = await import("${SERVER_CORE}");`,
        errors: [legacy("defineResource")],
      },
      // A member read off a bound, awaited dynamic import.
      {
        code: `
          const core = await import("${SERVER_CORE}");
          core.defineExternalResource(d, {});
        `,
        errors: [legacy("defineExternalResource")],
      },
      // A member read straight off an awaited dynamic import.
      {
        code: `(await import("${QUERY_RESOURCE_SERVER}")).windowQueryResource(spec);`,
        errors: [legacy("windowQueryResource")],
      },
    ],
  },
);
