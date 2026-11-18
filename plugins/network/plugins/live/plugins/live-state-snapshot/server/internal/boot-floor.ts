// The boot floor: the snapshot watermark `onReadyBlocking` takes before
// readiness flips — so before this process serves, and loads, any tuple. Every
// value this process reads afterwards already reflects each commit below it,
// so the boot catch-up owes a tuple it loaded only the changelog rows at or
// after it (`ReplayReach`). Taken only by the schema's owner, the one boot
// that installs the persist hooks — and so the only one whose `onReady`
// replays.
let floor: string | null = null;

export const bootFloor = {
  set(xid: string): void {
    floor = xid;
  },
  /** The floor `set` took; reading it first is a boot-order bug, and throws. */
  get(): string {
    if (floor === null) {
      throw new Error(
        "[live-state-snapshot] boot floor read before onReadyBlocking took it — the catch-up runs only after the owner's init",
      );
    }
    return floor;
  },
};
