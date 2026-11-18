import { writeFile } from "node:fs/promises";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";

/**
 * The `oom_score_adj` an op process (a build, a check, a test, a push, a
 * script run) takes on Linux: well above anything that serves the app, so when
 * the host runs out of memory the kernel kills the tooling, never the gateway,
 * Postgres or a backend.
 *
 * The kernel kills the process with the highest badness: its resident memory
 * plus `oom_score_adj / 1000` of the host's RAM. With no adjustment the
 * largest process is chosen, which is usually a type-check batch — but on a
 * small host a 1.5 GB main backend can outweigh the check child that actually
 * pushed the host over. 800 adds 80 % of RAM to every op process's badness, so
 * any op process outranks any serving one, whatever their sizes. Below 1000
 * (which marks a process as killed FIRST, always, before any other — even a
 * runaway non-op process) and above a desktop session's own +200 (Ubuntu's
 * `user@.service` puts every user process there, the gateway included —
 * measured on Ubuntu 24.04 desktop, 2026-11-18).
 */
export const OP_OOM_SCORE_ADJ = 800;

/** What {@link preferOomKill} did to this process. */
export type OomPreference =
  | { kind: "raised"; from: number; to: number }
  | { kind: "kept"; value: number }
  | { kind: "unsupported"; why: string };

const OOM_SCORE_ADJ = "/proc/self/oom_score_adj";

/**
 * Make THIS process (and every child it spawns from now on — the value is
 * inherited at fork) the kernel's first choice when the host runs out of
 * memory: `oom_score_adj` raised to {@link OP_OOM_SCORE_ADJ}, never lowered
 * (an ancestor op that already set it, or a higher value, is kept). Raising
 * one's own value needs no privilege.
 *
 * For an OP process only — the CLI's build / check / test / push / run, called
 * once where each op's lifecycle starts (`build`, `push`, `withDirectOp`). Never in a serving process (a
 * backend, the gateway): they are exactly what this protects. That is why it
 * is not attached to the host grant, which some backends take in-process.
 *
 * macOS has no per-process OOM order for user processes (memory pressure is
 * met with compression, swap and jetsam of apps, not a badness score), so
 * there it says so and changes nothing. A write the kernel refuses throws:
 * it would mean the protection is silently absent.
 */
export async function preferOomKill(): Promise<OomPreference> {
  if (process.platform !== "linux")
    return {
      kind: "unsupported",
      why: `${process.platform} has no per-process OOM kill order`,
    };
  const current = Number((await readFile(OOM_SCORE_ADJ, "utf8")).trim());
  if (!Number.isInteger(current))
    throw new Error(`${OOM_SCORE_ADJ} is not an integer`);
  if (current >= OP_OOM_SCORE_ADJ) return { kind: "kept", value: current };
  await writeFile(OOM_SCORE_ADJ, String(OP_OOM_SCORE_ADJ));
  return { kind: "raised", from: current, to: OP_OOM_SCORE_ADJ };
}
