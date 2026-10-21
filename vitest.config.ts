import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// Single repo-wide vitest project for browser/DOM + React tests.
//
// Convention: jsdom/React tests live co-located in each plugin's
// `web/__tests__/` folder and are auto-discovered here — no per-plugin config.
// Pure-logic tests stay as `bun:test` files next to their source (never under a
// `__tests__/` folder). Run with `./singularity test <path>`, which drives both
// runners, or `bun run test:dom` for this suite alone.
//
// The file layout alone does NOT keep the runners apart — for a long time this
// comment claimed it did. `include` below is only half of the split: it scopes
// vitest off bun's files, and `bunfig.toml`'s `pathIgnorePatterns` is the exact
// complementary half that scopes `bun test` off these. The two literals are a
// pair, bound by the `test-layout:runner-split` check
// (plugins/framework/plugins/tooling/plugins/test-layout), which fails if either
// side goes missing or a test file imports the other runner. Edit neither alone.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@plugins": path.resolve(__dirname, "plugins"),
      // Mirror web-core's composition build-gating alias so tests that pull in
      // App.tsx resolve. Tests always use the full registry.
      "@composition-web-registry": path.resolve(
        __dirname,
        "plugins/framework/plugins/web-sdk/core/web.generated.ts",
      ),
    },
  },
  test: {
    environment: "jsdom",
    // The locale and timezone every worker runs in, so a suite that formats a
    // date cannot pass for one runner and fail for another (`LANG=C.UTF-8`
    // renders `M06 17` where a laptop renders `Jun 17`). This is the one place
    // the locale CAN be pinned: it is read once when a process starts, so the
    // setup file is too late — but vitest starts each fork with `test.env` as
    // its environment. `forks` is named because a `threads` worker shares this
    // process, whose locale was fixed before this file ran. `test/setup.ts`
    // asserts the pin arrived; `test-layout:runner-split` rule (g) asserts
    // these three lines survive.
    pool: "forks",
    env: {
      LC_ALL: "en_US.UTF-8",
      TZ: "UTC",
    },
    setupFiles: [path.resolve(__dirname, "test/setup.ts")],
    include: ["plugins/**/web/__tests__/**/*.test.{ts,tsx}"],
  },
});
