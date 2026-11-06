// The file writes of migration generation, each told to the build's repo view
// (`noteRepoWrites`, tooling/core): the migrations dir is read again by the
// build's later readers (the drizzle-kit verdict, the browser host's bundled
// migrations), which then see the bytes written here without re-listing the
// tree. Same signatures as node:fs, so a writer here cannot forget the note.
import * as fs from "fs";
import { noteRepoWrites } from "@plugins/framework/plugins/tooling/core";

export function writeFileSync(
  path: string,
  data: string | NodeJS.ArrayBufferView,
): void {
  fs.writeFileSync(path, data);
  noteRepoWrites([path]);
}

export function rmSync(path: string, opts?: fs.RmOptions): void {
  fs.rmSync(path, opts);
  noteRepoWrites([path]);
}

export function renameSync(from: string, to: string): void {
  fs.renameSync(from, to);
  noteRepoWrites([from, to]);
}
