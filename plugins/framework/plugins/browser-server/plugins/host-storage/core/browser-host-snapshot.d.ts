// A browser host's starting snapshot, as its worker imports it: the module
// web-artifacts generates beside the snapshot file it built for the host
// (`web-artifacts/core/internal/host-snapshots.ts`, from the host's
// `bin/browser-host.snapshot.ts`) and links into the worker tree as
// `@browser-host-snapshot/<pluginPath>`. Typed here rather than through a
// tsconfig path: the module exists only in a built dist.
declare module "@browser-host-snapshot/*" {
  /** Which snapshot the build took (its file's hash), when, and its bytes. */
  const snapshot: {
    readonly version: string;
    readonly takenAt: number;
    load(): Promise<Uint8Array>;
  };
  export default snapshot;
}
