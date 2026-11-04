/**
 * Replay a recorded fs-latency monitor log through the io-health detector and
 * print every finding raised and cleared, with the tick that did it — the
 * check that the thresholds fire on an incident and stay quiet on a healthy
 * stretch.
 *
 *   ./equin run plugins/infra/plugins/host/plugins/io-health/scripts/replay-monitor-log.ts \
 *     [--log <path>] [--fixed-at 2026-11-04T16:23]
 *
 * `--log` defaults to the live log (copy it first if the monitor is writing).
 * `--fixed-at` (UTC ISO prefix) splits the summary: what was raised before the
 * instant, what was raised after it (should be nothing on a real fix), and
 * when the last finding raised before it cleared.
 */
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { monitorLogsDir } from "@plugins/debug/data-dirs";
import {
  FS_LATENCY_LOG_NAME,
  createIoHealthDetector,
  findingKey,
  parseTickLine,
} from "../core";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const log = arg("--log") ?? monitorLogsDir.file(FS_LATENCY_LOG_NAME);
const fixedAt = arg("--fixed-at");

const detector = createIoHealthDetector();
const raisedBefore: string[] = [];
const raisedAfter: string[] = [];
let lastClearOfBefore: string | null = null;
const fromBefore = new Set<string>();
let ticks = 0;

for (const line of readFileSync(log, "utf8").split("\n")) {
  if (line.trim() === "") continue;
  const tick = parseTickLine(line);
  ticks++;
  const step = detector.push(tick);
  const after = fixedAt !== undefined && tick.iso >= fixedAt;
  for (const f of step.raised) {
    console.log(`${tick.iso}  RAISE  ${findingKey(f).padEnd(28)} ${f.summary}`);
    (after ? raisedAfter : raisedBefore).push(`${tick.iso} ${findingKey(f)}`);
    if (!after) fromBefore.add(findingKey(f));
  }
  for (const f of step.cleared) {
    console.log(
      `${tick.iso}  CLEAR  ${findingKey(f).padEnd(28)} (held since ${new Date(f.since).toISOString()})`,
    );
    if (fromBefore.has(findingKey(f)) && after) lastClearOfBefore = tick.iso;
  }
}

const still = detector.active();
console.log(
  `\n${ticks} ticks replayed, ${detector.outOfOrder()} out of order dropped`,
);
console.log(
  `active at the end: ${still.length === 0 ? "none" : still.map(findingKey).join(", ")}`,
);
if (fixedAt !== undefined) {
  console.log(`raised before ${fixedAt}: ${raisedBefore.length}`);
  console.log(
    `raised after ${fixedAt}: ${raisedAfter.length}${raisedAfter.length ? "\n  " + raisedAfter.join("\n  ") : ""}`,
  );
  console.log(
    `last finding from before the fix cleared at: ${lastClearOfBefore ?? "-"}`,
  );
}
