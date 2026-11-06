import { dlopen, ptr } from "bun:ffi";
import type { Region, RegionReader } from "./fork-tree-meter";

// One VM region of another process: libproc's
// proc_pidinfo(PROC_PIDREGIONINFO), which takes a pid (no task port, no
// entitlement — the same account suffices) and an address, and fills the
// region holding that address, or the first one after it:
//
//   struct proc_regioninfo {                    // offset
//     uint32_t pri_protection;                  //  0
//     uint32_t pri_max_protection;              //  4
//     uint32_t pri_inheritance;                 //  8
//     uint32_t pri_flags;                       // 12
//     uint64_t pri_offset;                      // 16
//     uint32_t pri_behavior;                    // 24
//     uint32_t pri_user_wired_count;            // 28
//     uint32_t pri_user_tag;                    // 32
//     uint32_t pri_pages_resident;              // 36
//     uint32_t pri_pages_shared_now_private;    // 40
//     uint32_t pri_pages_swapped_out;           // 44
//     uint32_t pri_pages_dirtied;               // 48
//     uint32_t pri_ref_count;                   // 52
//     uint32_t pri_shadow_depth;                // 56
//     uint32_t pri_share_mode;                  // 60
//     uint32_t pri_private_pages_resident;      // 64
//     uint32_t pri_shared_pages_resident;       // 68
//     uint32_t pri_obj_id;                      // 72
//     uint32_t pri_depth;                       // 76
//     uint64_t pri_address;                     // 80
//     uint64_t pri_size;                        // 88
//   };                                          // size 96
//
// The kernel counts the region's pages one by one (60–100 µs a call for a
// typical region, more for a large one): synchronous, so it runs on the
// fork-memory worker thread, never on a backend's event loop.

const PROC_PIDREGIONINFO = 7;
const REGION_INFO_BYTES = 96;

interface Binding {
  procPidinfo: (
    pid: number,
    flavor: number,
    arg: number,
    buf: unknown,
    size: number,
  ) => number;
  pageBytes: number;
}

let binding: Binding | null = null;
function bind(): Binding {
  if (!binding) {
    const { symbols } = dlopen("libc.dylib", {
      proc_pidinfo: {
        args: ["i32", "i32", "u64", "ptr", "i32"],
        returns: "i32",
      },
      getpagesize: { args: [], returns: "i32" },
    });
    binding = {
      procPidinfo: symbols.proc_pidinfo as Binding["procPidinfo"],
      pageBytes: symbols.getpagesize(),
    };
  }
  return binding;
}

/** The VM page the region counts are in: this machine's (every process's on it). */
export function regionPageBytes(): number {
  return bind().pageBytes;
}

const buf = new Uint8Array(REGION_INFO_BYTES);
const view = new DataView(buf.buffer);

/**
 * The region of `pid` holding `address`, or the first after it; null past the
 * last region, or when the kernel refuses (another account's process, or one
 * gone). Addresses fit a double exactly (user space is below 2^47).
 */
export const readProcRegion: RegionReader = (pid, address) => {
  if (process.platform !== "darwin") {
    throw new Error("[machine-usage] proc_pidinfo regions are macOS-only");
  }
  const n = bind().procPidinfo(
    pid,
    PROC_PIDREGIONINFO,
    address,
    ptr(buf),
    REGION_INFO_BYTES,
  );
  if (n !== REGION_INFO_BYTES) return null;
  const u32 = (offset: number) => view.getUint32(offset, true);
  const start = Number(view.getBigUint64(80, true));
  const region: Region = {
    start,
    end: start + Number(view.getBigUint64(88, true)),
    protection: u32(0),
    inheritance: u32(8),
    shareMode: u32(60),
    residentPages: u32(36),
    swappedPages: u32(44),
    privateResidentPages: u32(64),
    objectId: u32(72),
  };
  return region;
};
