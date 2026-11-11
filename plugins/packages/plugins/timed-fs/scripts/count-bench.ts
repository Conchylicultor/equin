// What counting costs per file call (`countFsCall`: the process tally, the
// path prefix, no scope open) — it runs on every timed call of every process.
//   ./equin run plugins/packages/plugins/timed-fs/scripts/count-bench.ts
import { countFsCall } from "../core/internal/fs-call-count";

const path = `${process.cwd()}/plugins/apps/plugins/x/web/index.ts`;
const N = 2_000_000;
for (let i = 0; i < 100_000; i++) countFsCall("fs-stat", path);
const t0 = performance.now();
for (let i = 0; i < N; i++) countFsCall("fs-stat", path);
console.log(`${(((performance.now() - t0) * 1e6) / N).toFixed(0)} ns per call`);
