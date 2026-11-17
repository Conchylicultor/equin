// Writes an event stream that reproduces the approved mockup's running moment
// (proto-1794832268-wlybzk, `view=window state=running`): the build group
// active, a sub-step at 137 of 312, About 7 minutes remaining, the mockup's
// log lines — for `replay.ts` to draw and compare against the mockup.
//
//   ./equin run plugins/installer/plugins/window/e2e/running-moment.ts --out "$EQUIN_SCRATCH/running.jsonl"
//
// Prints the instant to replay it at (`--now`). The plan's words and medians
// are the mockup's, not install.sh's: the mockup draws "Compiling native
// modules", its own leaves' medians and a machine 7% slower than them, so the
// fixture names the same strings and times to make the two comparable. The
// mockup's log text is its own simulation (`logLines`), ported here verbatim.
import { writeFileSync } from "node:fs";
import { InstallEvent, type InstallEventBody } from "@plugins/installer/core";
import { requireArg } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = requireArg("out", "running-moment.ts --out <events.jsonl>");

const T0 = Date.parse("2026-11-17T15:00:00Z");
const iso = (s: number): string =>
  new Date(T0 + Math.round(s) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

// ── The mockup's simulation, verbatim ───────────────────────────────────────
const CRATES = [
  "libc",
  "proc-macro2",
  "unicode-ident",
  "quote",
  "syn",
  "serde",
  "serde_derive",
  "serde_json",
  "cc",
  "memchr",
  "ring",
  "regex-syntax",
  "aho-corasick",
  "bytes",
  "mio",
  "tokio",
  "napi-sys",
  "napi",
  "napi-derive",
  "smallvec",
  "hashbrown",
  "indexmap",
  "rayon-core",
  "rayon",
  "crossbeam-utils",
  "lightningcss",
  "oxc_allocator",
  "oxc_parser",
  "swc_common",
  "swc_ecma_ast",
];
const PKGS = [
  "react@18.3.1",
  "drizzle-orm@0.44.2",
  "vite@7.1.3",
  "zod@4.1.5",
  "@tanstack/react-query@5.85.0",
  "playwright-core@1.55.0",
  "postgres@3.4.7",
  "commander@14.0.0",
  "sonner@2.0.7",
];
function logLines(id: string, frac: number, n: number): string[] {
  const k = Math.floor(frac * 1000);
  const lines: string[] = [];
  for (let j = n - 1; j >= 0; j--) {
    const s = k - j * 7;
    switch (id) {
      case "mise":
        lines.push(`mise: installing mise 2026.11.2 → ~/.local/bin/mise`);
        break;
      case "clone":
        lines.push(
          `Receiving objects: ${Math.min(100, Math.floor(frac * 100) - j)}% (${Math.floor(frac * 214031) - j * 812}/214031), ${(frac * 412 - j).toFixed(1)} MiB`,
        );
        break;
      case "toolchain":
        lines.push(
          frac < 0.2
            ? `mise bun@1.3.2       ✓ installed`
            : frac < 0.35
              ? `mise go@1.25.4       ✓ installed`
              : `mise rust@1.91.1     downloading rust-std (${Math.floor(((frac - 0.35) / 0.65) * 100) - j}%)`,
        );
        break;
      case "services":
        lines.push(
          frac < 0.5
            ? `gateway: go build ./gateway (${Math.floor(frac * 200) - j * 3}%)`
            : `postgres: initdb — ${["creating directories", "creating template1", "syncing data", "ready on socket"][Math.min(3, Math.floor((frac - 0.5) * 8))]}`,
        );
        break;
      case "deps":
        lines.push(
          `+ ${PKGS[((s % PKGS.length) + PKGS.length) % PKGS.length]}  (${Math.floor(frac * 1412) - j * 9}/1412 packages)`,
        );
        break;
      case "native": {
        const c = Math.floor(frac * 312) - j;
        lines.push(
          `   Compiling ${CRATES[((c % CRATES.length) + CRATES.length) % CRATES.length]} v${1 + (c % 3)}.${c % 17}.${c % 9}  [${c}/312]`,
        );
        break;
      }
    }
  }
  return [...new Set(lines)].map((l) => l.trim());
}
const PACE = 1.07;
const dur = (est: number): number => Math.round(est * PACE);

// ── The stream ──────────────────────────────────────────────────────────────
const stamped: string[] = [];
let clock = 0;
const emit = (e: InstallEventBody): void => {
  const line = JSON.stringify({ v: 1, t: iso(clock), ...e });
  InstallEvent.parse(JSON.parse(line));
  stamped.push(line);
};

emit({
  type: "plan",
  release: null,
  platform: "darwin-arm64",
  mode: "window",
  groups: [
    { id: "prepare", label: "Prepare your Mac" },
    { id: "download", label: "Download equin" },
    { id: "tools", label: "Install tools" },
    { id: "services", label: "Start services" },
    { id: "build", label: "Build equin" },
  ],
  steps: [
    {
      id: "tools",
      label: "Developer tools",
      doing: "Installing the developer tools",
      group: "prepare",
      est_s: 0,
    },
    {
      id: "mise",
      label: "Tool manager",
      doing: "Installing the tool manager",
      group: "prepare",
      est_s: 8,
    },
    {
      id: "clone",
      label: "Download equin",
      doing: "Downloading equin",
      group: "download",
      est_s: 40,
    },
    {
      id: "toolchain",
      label: "Toolchain",
      doing: "Installing Bun, Go and Rust",
      group: "tools",
      est_s: 110,
    },
    {
      id: "start",
      label: "Start services",
      doing: "Starting the gateway and database",
      group: "services",
      est_s: 35,
    },
    {
      id: "build",
      label: "Build equin",
      doing: "Building equin",
      group: "build",
      est_s: 520,
      substeps: [
        {
          id: "build.database",
          label: "Prepare the database",
          doing: "Preparing the database",
          est_s: 0,
        },
        {
          id: "build.deps",
          label: "Install dependencies",
          doing: "Installing dependencies",
          est_s: 55,
        },
        // The mockup's native-modules leaf, at this sub-step's place.
        {
          id: "build.codegen",
          label: "Compile native modules",
          doing: "Compiling native modules",
          est_s: 190,
        },
        // The mockup's code generation, database and interface leaves (25 + 15 + 210).
        {
          id: "build.interface",
          label: "Build the interface",
          doing: "Building the interface",
          est_s: 250,
        },
        {
          id: "build.deploy",
          label: "Start equin",
          doing: "Starting equin",
          est_s: 25,
        },
      ],
    },
  ],
});
emit({ type: "step", id: "tools", state: "skipped" });

const run = (
  id: "mise" | "clone" | "toolchain" | "start" | "build.deps",
  mockId: string,
  est: number,
): void => {
  emit({ type: "step", id, state: "start" });
  for (const line of logLines(mockId, 1, 4))
    emit({ type: "log", step: id, stream: "out", line });
  clock += dur(est);
  emit({ type: "step", id, state: "done", ms: dur(est) * 1000 });
};
run("mise", "mise", 8);
run("clone", "clone", 40);
run("toolchain", "toolchain", 110);
run("start", "services", 35);
emit({ type: "step", id: "build", state: "start" });
emit({ type: "step", id: "build.database", state: "skipped" });
run("build.deps", "deps", 55);

const FRAC = 0.44;
emit({ type: "step", id: "build.codegen", state: "start" });
const codegenAt = clock;
const worked = dur(190) * FRAC;
for (const line of logLines("native", FRAC, 40))
  emit({ type: "log", step: "build.codegen", stream: "out", line });
clock = codegenAt + Math.floor(worked);
emit({
  type: "progress",
  id: "build.codegen",
  done: Math.floor(FRAC * 312),
  total: 312,
  unit: "crates",
});

writeFileSync(out, `${stamped.join("\n")}\n`);
const now = new Date(T0 + (codegenAt + worked) * 1000).toISOString();
console.log(`wrote ${stamped.length} events to ${out}`);
console.log(`replay at --now ${now}`);
