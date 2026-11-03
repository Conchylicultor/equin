/**
 * Tests for the `no-handrolled-result` lint rule: outside live-state and
 * network/live, a literal or type spelling a resource result's `status` arms is
 * flagged; domain state machines that share a word, the owning plugins, and
 * test fixtures are not.
 */

import rule from "./no-handrolled-result";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const DOMAIN = "/repo/plugins/tasks/web/internal/use-thing.ts";

ruleTester.run("no-handrolled-result", rule, {
  valid: [
    // A domain state machine that shares the word "loading".
    {
      filename: DOMAIN,
      code: `
          type ResolvedFileState =
            | { status: "loading" }
            | { status: "exact"; path: string }
            | { status: "not-found" };
          const s = { status: "loading" };
        `,
      },
      // A domain "error" state with its own payload, no result members.
      {
        filename: DOMAIN,
        code: `
          type RunRead = { status: "error"; error: Error } | { status: "found"; run: Run };
          const r = { status: "error", error };
        `,
      },
      // Deriving through the primitive is the sanctioned shape.
      {
        filename: DOMAIN,
        code: `const r = mapResource(read, (rows) => rows[0] ?? null);`,
      },
      // The owning plugins spell the shape.
      {
        filename:
        "/repo/plugins/network/plugins/live/plugins/live-state/web/use-resource.ts",
        code: `const r = { status: "loading", pending: true, error: null, refetch };`,
      },
      {
        filename: "/repo/plugins/network/plugins/live/web/internal/use-live.ts",
        code: `const r = { status: "error", pending: true, error, refetch };`,
      },
      // Test fixtures stand in for a read.
      {
        filename: "/repo/plugins/tasks/web/__tests__/thing.test.tsx",
        code: `const r = { status: "loading", pending: true, error: null, refetch };`,
      },
    ],
    invalid: [
      {
        filename: DOMAIN,
        code: `const r = { status: "loading", pending: true, error: null, refetch };`,
        errors: [{ messageId: "handrolled" }],
      },
      {
        filename: DOMAIN,
        code: `const r = { status: "error", error, stale, refetch: read.refetch };`,
        errors: [{ messageId: "handrolled" }],
      },
      {
        filename: DOMAIN,
        code: `const r = { status: "ready", pending: false, data, refetch };`,
        errors: [{ messageId: "handrolled" }],
      },
      // A union spelling the result vocabulary.
      {
        filename: DOMAIN,
        code: `
          type Mine<T> =
            | { status: "loading" }
            | { status: "error"; error: Error }
            | { status: "ready"; data: T };
        `,
        errors: [{ messageId: "handrolled" }],
      },
      // A lone type literal arm.
      {
        filename: DOMAIN,
        code: `type Arm = { status: "error"; error: Error; refetch: () => void };`,
        errors: [{ messageId: "handrolled" }],
      },
    ],
  },
);
