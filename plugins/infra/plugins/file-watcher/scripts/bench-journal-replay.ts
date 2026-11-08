// What a journal catch-up costs as a function of how far back its cursor is.
//
//   ./equin run plugins/infra/plugins/file-watcher/scripts/bench-journal-replay.ts \
//     <root> [--back 100000,1000000,5000000]
//
// Takes a cursor now, then replays from cursors N event ids earlier (the
// journal is volume-wide, so N counts every change on the volume, not only
// those under <root>), timing each replay and counting the paths it names.
import { journalChangesSince, journalCursor } from "../shared/journal";

const args = process.argv.slice(2);
const root = args[0];
if (root === undefined)
  throw new Error("usage: bench-journal-replay.ts <root> [--back a,b,c]");
const i = args.indexOf("--back");
const backs = (i < 0 ? "10000,100000,1000000,3000000" : args[i + 1]!)
  .split(",")
  .map(Number);

const now = await journalCursor(root);
if (now.kind !== "cursor") throw new Error(now.reason);
console.log(`cursor now: ${now.cursor.eventId}`);
for (const back of backs) {
  const eventId = String(BigInt(now.cursor.eventId) - BigInt(back));
  const takenAt = Date.now() - 60_000;
  const cursor = {
    ...now.cursor,
    eventId,
    takenAt,
    snapshot: `${eventId}\n${BigInt(takenAt) * 1_000_000n}`,
  };
  const t0 = performance.now();
  const replay = await journalChangesSince(cursor);
  const ms = performance.now() - t0;
  console.log(
    `back ${back.toLocaleString()} ids: ${ms.toFixed(0)} ms, ` +
      (replay.kind === "changes"
        ? `${replay.paths.length} paths`
        : `unknown: ${replay.reason}`),
  );
}
