// Writes an event stream that reproduces one moment of the approved mockup's
// window view (proto-1794832268-wlybzk), for `replay.ts` to draw and compare
// against the mockup at the same options:
//
//   ./equin run plugins/installer/plugins/window/e2e/moment.ts --out "$EQUIN_SCRATCH/m.jsonl" \
//     [--state running|failed|fixing|done] [--failure sandbox|security|stall] [--claude app|cli]
//
// running: the build group active, a sub-step at 137 of 312, About 7 minutes
// remaining. failed / fixing: the mockup's failure (`failure=`) at its own
// place in the install, as the step engine would pause it (sandbox and
// security stop their step; a stall does not), and Fix with Claude started
// (`--claude`, the mockup's remembered target). done: every step finished.
//
// Prints the instant to replay it at (`--now`). The plan's words and medians
// are the mockup's, not install.sh's: the mockup draws "Compiling native
// modules", its own leaves' medians and a machine 7% slower than them, so the
// fixture names the same strings and times to make the two comparable. The
// mockup's log text and failures are its own simulation, ported verbatim.
import { writeFileSync } from "node:fs";
import { InstallEvent, type InstallEventBody } from "@plugins/installer/core";
import {
  arg,
  requireArg,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = requireArg(
  "out",
  "moment.ts --out <events.jsonl> [--state running|failed|fixing|done] [--failure sandbox|security|stall] [--claude app|cli]",
);
const state = arg("state") ?? "running";
const failureName = arg("failure") ?? "sandbox";
const claude = arg("claude") === "cli" ? "cli" : "app";
if (!["running", "failed", "fixing", "done"].includes(state))
  throw new Error(`--state ${state}: running, failed, fixing or done`);

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

// ── The mockup's failures (FAILURES), verbatim ─────────────────────────────
const FAILURES = {
  sandbox: {
    leaf: "native",
    frac: 0.46,
    kind: "sandbox",
    title: "Blocked by the app you started it from",
    plain:
      "The install builds parts of equin on your Mac, and the coding tool you ran it from doesn't allow that. Run it from the Terminal app instead.",
    evidence: [
      "error: could not compile `ring` (build script)",
      "process didn't exit successfully: signal 9, SIGKILL",
      "parent process: sandbox-exec (started by another coding tool)",
    ],
  },
  security: {
    leaf: "services",
    frac: 0.3,
    kind: "security",
    title: "Your company's security software removed part of equin",
    plain:
      "Jamf Protect deletes programs it hasn't seen before, including the one that connects equin to your browser. Your IT team can allow it.",
    evidence: [
      "./equin start: exec ~/.equin/bin/gateway: no such file or directory",
      "JamfProtect: quarantined ~/.equin/bin/gateway (unsigned, first seen)",
    ],
  },
  stall: {
    leaf: "frontend",
    frac: 0.31,
    kind: "stall",
    title: "The install is waiting for an older task",
    plain:
      "equin builds one thing at a time. A test started 3 hours ago stopped responding and is holding the turn. Stopping it lets the install continue.",
    evidence: [
      "waiting for host grant · holder op-48211 (test, pid 48211)",
      "holder's last output: 3h 9m ago",
    ],
  },
} as const;
const failure = FAILURES[failureName as keyof typeof FAILURES];
if (failure === undefined)
  throw new Error(`--failure ${failureName}: sandbox, security or stall`);

/** The install's steps, as the mockup's leaves (with their medians) make them up. */
type StepId =
  | "mise"
  | "clone"
  | "toolchain"
  | "start"
  | "build.deps"
  | "build.codegen"
  | "build.interface"
  | "build.deploy";
const SEQ: Array<{ id: StepId; mock: Array<[string, number]> }> = [
  { id: "mise", mock: [["mise", 8]] },
  { id: "clone", mock: [["clone", 40]] },
  { id: "toolchain", mock: [["toolchain", 110]] },
  { id: "start", mock: [["services", 35]] },
  { id: "build.deps", mock: [["deps", 55]] },
  { id: "build.codegen", mock: [["native", 190]] },
  {
    id: "build.interface",
    mock: [
      ["codegen", 25],
      ["db", 15],
      ["frontend", 210],
    ],
  },
  { id: "build.deploy", mock: [["deploy", 25]] },
];

/** Where the moment is: a mockup leaf and how far into it (null: all done). */
const at: { leaf: string; frac: number } | null =
  state === "done"
    ? null
    : state === "running"
      ? { leaf: "native", frac: 0.44 }
      : { leaf: failure.leaf, frac: failure.frac };

let now = clock;
for (const { id, mock } of SEQ) {
  if (id === "build.deps") {
    emit({ type: "step", id: "build", state: "start" });
    emit({ type: "step", id: "build.database", state: "skipped" });
  }
  const here = at === null ? -1 : mock.findIndex(([m]) => m === at.leaf);
  emit({ type: "step", id, state: "start" });
  if (here < 0) {
    for (const [m] of mock)
      for (const line of logLines(m, 1, 4))
        emit({ type: "log", step: id, stream: "out", line });
    const took = mock.reduce((sum, [, est]) => sum + dur(est), 0);
    clock += took;
    emit({ type: "step", id, state: "done", ms: took * 1000 });
    continue;
  }
  // The moment's step: worked up to the leaf, then its fraction of it.
  if (at === null) throw new Error("unreachable: no moment while one is found");
  const before = mock
    .slice(0, here)
    .reduce((sum, [, est]) => sum + dur(est), 0);
  const [leafId, leafEst] = mock[here]!;
  const worked = before + dur(leafEst) * at.frac;
  for (const line of logLines(leafId, at.frac, 40))
    emit({ type: "log", step: id, stream: "out", line });
  now = clock + worked;
  clock += Math.floor(worked);
  if (state === "running") {
    emit({
      type: "progress",
      id,
      done: Math.floor(at.frac * 312),
      total: 312,
      unit: "crates",
    });
    break;
  }
  const blocking = failure.kind !== "stall";
  if (blocking)
    emit({ type: "step", id, state: "failed", ms: Math.round(worked * 1000) });
  emit({
    type: "pause",
    step: id,
    kind: failure.kind,
    title: failure.title,
    text: failure.plain,
    evidence: [...failure.evidence],
    blocking,
    optional: false,
    manual: null,
  });
  if (state === "fixing")
    emit({ type: "fixing", target: claude, clipboard: claude === "app" });
  break;
}
if (at === null) {
  emit({ type: "step", id: "build", state: "done", ms: 0 });
  emit({ type: "done", url: "http://equin.localhost:9000", ms: clock * 1000 });
  now = clock;
}

writeFileSync(out, `${stamped.join("\n")}\n`);
console.log(`wrote ${stamped.length} events to ${out}`);
console.log(`replay at --now ${new Date(T0 + now * 1000).toISOString()}`);
