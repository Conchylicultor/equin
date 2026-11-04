#!/usr/bin/python3 -I
"""File-metadata latency monitor — one tick per launchd invocation (StartInterval).

Answers: how long does a file-metadata operation take on this machine right
now, at the two scheduling tiers equin runs at (foreground and darwinbg), and
how long does the file cache keep what was just read?

Each tick (no in-process timer: launchd runs the script, it measures, appends
one JSON line to ~/.equin/logs/monitors/fs-latency.jsonl, and exits):

  probes      cold `lstat` of 40 files and a cold `readdir` of one 500-entry
              directory from a private corpus, once in the foreground and once
              in darwinbg (setpriority(PRIO_DARWIN_PROCESS) on this process,
              the same switch spawn-priority uses). The corpus is 10 dirs ×
              500 files, visited round-robin, so a probe touches a file again
              only every ~10 ticks: the reading is the cold cost unless the
              cache outlives that interval.
  residency   12 canary groups × 50 files, one re-read per tick (round-robin).
              Before re-reading, every group's resident-page fraction is read
              with mincore() beside its age since its last read — the age at
              which residency drops IS the file cache's lifetime.
  kernel      vnode counters (vfs.vnstats: new vnodes/s, recycled/s, table
              size vs kern.maxvnodes), disk ops/bytes and device time per op
              (IOBlockStorageDriver Statistics), load average.
  daemons     %CPU of the system daemons that were suspects (fseventsd,
              syspolicyd, XprotectService, mds, mds_stores, corecaptured), and
              corecaptured's pid and age: a pid that changes every ~5 min is
              its relaunch loop, each launch replaying fseventsd's history
              from a purge marker that never advances (CLAUDE.md).
  readers     root only: the processes reading the most from disk since the
              last tick (proc_pid_rusage, root daemons included), and the
              fseventsd log files fseventsd holds open. A history replay
              shows as a log file far behind the one being written, advancing
              tick after tick.

A tick whose slowest single operation exceeds STALL_MS (default 1000) also
writes `"stall": true`; when run as root it captures a 5 s `fs_usage -f
filesys` sample into fs-latency-incidents/<ts>.txt.gz (who is doing the
lookups) — rate-limited to one per INCIDENT_COOLDOWN_S.

Read it with report.py (hourly p50/p99/max, cache lifetime, stalls).
"""

import ctypes
import gzip
import json
import mmap
import os
import re
import subprocess
import sys
import time

STALL_MS = float(os.environ.get("STALL_MS", "1000"))
INCIDENT_COOLDOWN_S = float(os.environ.get("INCIDENT_COOLDOWN_S", "600"))
PROBE_DIRS = 10
PROBE_DIR_FILES = 500
LSTAT_PER_TICK = 40
CANARY_GROUPS = 12
CANARY_FILES = 50
CANARY_BYTES = 16384

libc = ctypes.CDLL(None, use_errno=True)
PRIO_DARWIN_PROCESS = 4
PRIO_DARWIN_BG = 0x1000


def data_root():
    home = os.environ.get("MONITOR_HOME") or os.path.expanduser("~")
    return os.path.join(home, ".equin")


ROOT = os.path.join(data_root(), "logs", "monitors")
CORPUS = os.path.join(ROOT, "fs-latency-corpus")
STATE = os.path.join(ROOT, "fs-latency.state.json")
LOG = os.path.join(ROOT, "fs-latency.jsonl")
INCIDENTS = os.path.join(ROOT, "fs-latency-incidents")


def set_darwinbg(on):
    if libc.setpriority(PRIO_DARWIN_PROCESS, 0, PRIO_DARWIN_BG if on else 0) != 0:
        raise OSError(ctypes.get_errno(), "setpriority(PRIO_DARWIN_PROCESS)")
    if libc.getpriority(PRIO_DARWIN_PROCESS, 0) != (1 if on else 0):
        raise RuntimeError("darwinbg state did not take")


def ensure_corpus():
    marker = os.path.join(CORPUS, ".complete")
    if os.path.exists(marker):
        return
    blob = os.urandom(CANARY_BYTES)
    for d in range(PROBE_DIRS):
        p = os.path.join(CORPUS, f"probe-{d:02d}")
        os.makedirs(p, exist_ok=True)
        for f in range(PROBE_DIR_FILES):
            open(os.path.join(p, f"f{f:04d}"), "wb").close()
    for g in range(CANARY_GROUPS):
        p = os.path.join(CORPUS, f"canary-{g:02d}")
        os.makedirs(p, exist_ok=True)
        for f in range(CANARY_FILES):
            with open(os.path.join(p, f"c{f:03d}"), "wb") as fh:
                fh.write(blob)
    open(marker, "w").close()


def timed(fn):
    t = time.perf_counter()
    fn()
    return (time.perf_counter() - t) * 1000.0


def probe(tier_bg, tick):
    """Cold lstat + readdir in the given tier; ms values."""
    set_darwinbg(tier_bg)
    try:
        # Two tiers per tick each get their own directory, so neither warms the other's.
        d_lstat = (2 * tick + (1 if tier_bg else 0)) % PROBE_DIRS
        d_readdir = (d_lstat + PROBE_DIRS // 2) % PROBE_DIRS
        base = os.path.join(CORPUS, f"probe-{d_lstat:02d}")
        start = ((tick // PROBE_DIRS) * LSTAT_PER_TICK) % PROBE_DIR_FILES
        lst = []
        for i in range(LSTAT_PER_TICK):
            path = os.path.join(base, f"f{(start + i) % PROBE_DIR_FILES:04d}")
            lst.append(timed(lambda: os.lstat(path)))
        rd_path = os.path.join(CORPUS, f"probe-{d_readdir:02d}")
        rd = timed(lambda: sum(1 for _ in os.scandir(rd_path)))
    finally:
        set_darwinbg(False)
    lst.sort()
    return {
        "lstat_p50": round(lst[len(lst) // 2], 3),
        "lstat_max": round(lst[-1], 3),
        "lstat_sum": round(sum(lst), 2),
        "readdir500": round(rd, 2),
        "max_op": round(max(lst[-1], rd), 2),
    }


def resident_fraction(group):
    res = tot = 0
    page = mmap.PAGESIZE
    vec = (ctypes.c_char * ((CANARY_BYTES + page - 1) // page))()
    libc.mincore.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p]
    for f in range(CANARY_FILES):
        path = os.path.join(CORPUS, f"canary-{group:02d}", f"c{f:03d}")
        fd = os.open(path, os.O_RDONLY)
        try:
            m = mmap.mmap(fd, CANARY_BYTES, prot=mmap.PROT_READ)
        finally:
            os.close(fd)
        try:
            addr = _mmap_address(m)
            if libc.mincore(addr, CANARY_BYTES, vec) != 0:
                raise OSError(ctypes.get_errno(), "mincore")
            n = len(vec)
            res += sum(1 for k in range(n) if vec[k][0] & 1)
            tot += n
        finally:
            m.close()
    return res / tot if tot else 0.0


def _mmap_address(m):
    # A read-only mmap cannot back ctypes.from_buffer; get its address from the
    # buffer protocol through PyObject_GetBuffer.
    class Py_buffer(ctypes.Structure):
        _fields_ = [("buf", ctypes.c_void_p), ("obj", ctypes.py_object), ("len", ctypes.c_ssize_t),
                    ("itemsize", ctypes.c_ssize_t), ("readonly", ctypes.c_int), ("ndim", ctypes.c_int),
                    ("format", ctypes.c_char_p), ("shape", ctypes.c_void_p), ("strides", ctypes.c_void_p),
                    ("suboffsets", ctypes.c_void_p), ("internal", ctypes.c_void_p)]
    b = Py_buffer()
    ctypes.pythonapi.PyObject_GetBuffer(ctypes.py_object(m), ctypes.byref(b), 0)
    try:
        return b.buf
    finally:
        ctypes.pythonapi.PyBuffer_Release(ctypes.byref(b))


def rewarm(group):
    base = os.path.join(CORPUS, f"canary-{group:02d}")
    for f in range(CANARY_FILES):
        with open(os.path.join(base, f"c{f:03d}"), "rb") as fh:
            fh.read()


def run_out(argv, check=False):
    """A command's stdout as text, decoded tolerantly: ps truncates process names to a byte
    count, which can split a multi-byte character (the middle dot in `equin · …`)."""
    return subprocess.run(argv, capture_output=True, check=check).stdout.decode("utf-8", "replace")


def sysctl_ints(names):
    out = run_out(["/usr/sbin/sysctl"] + names, check=True)
    vals = {}
    for line in out.splitlines():
        k, _, v = line.partition(":")
        vals[k.strip()] = int(v.strip()) if v.strip().lstrip("-").isdigit() else v.strip()
    return vals


def disk_stats():
    out = run_out(["/usr/sbin/ioreg", "-c", "IOBlockStorageDriver", "-r", "-w0", "-k", "Statistics"], check=True)
    best = None
    for blob in re.findall(r'"Statistics" = \{([^}]*)\}', out):
        kv = dict((k, int(v)) for k, v in re.findall(r'"([^"]+)"=(\d+)', blob))
        if best is None or kv.get("Operations (Read)", 0) > best.get("Operations (Read)", 0):
            best = kv
    return best or {}


def daemon_cpu():
    out = run_out(["/bin/ps", "-Ao", "pcpu=,comm="], check=True)
    want = {"fseventsd": 0.0, "syspolicyd": 0.0, "XprotectService": 0.0, "mds": 0.0, "mds_stores": 0.0,
            "corecaptured": 0.0}
    for line in out.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2:
            continue
        name = os.path.basename(parts[1])
        if name in want:
            want[name] += float(parts[0])
    return want


libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
RUSAGE_INFO_V2 = 2
TOP_READERS = 8


class RusageV2(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [
        (n, ctypes.c_uint64)
        for n in ("ut", "st", "pkg_idle", "int_wk", "pageins", "wired", "resident", "phys", "start", "exit",
                  "child_ut", "child_st", "child_pkg", "child_int", "child_pageins", "child_elapsed",
                  "diskio_read", "diskio_write")
    ]


def disk_readers(now, state):
    """Root only: disk bytes read since the last tick, by process name (MB/s).

    Returns (top, attributed, born): the top readers by name; the total over
    EVERY live process; and the part of it read by processes born since the
    last tick. A process born mid-tick is counted from 0 (its whole read is
    this tick's), else the short-lived ones a busy fleet spawns (git, hook
    runs) are dropped at their first sight. What none of them explains —
    `disk_read_mb_s` minus `attributed` — is processes that started and exited
    between two ticks, and the kernel's own reads.
    """
    out = run_out(["/bin/ps", "-Ao", "pid=,etime=,comm="])
    prev, prev_t = state.get("readers_prev", {}), state.get("readers_t")
    cur, by_name, born = {}, {}, 0
    for line in out.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) != 3:
            continue
        pid, ru = int(parts[0]), RusageV2()
        if libproc.proc_pid_rusage(pid, RUSAGE_INFO_V2, ctypes.byref(ru)) != 0:
            continue
        cur[str(pid)] = ru.diskio_read
        if str(pid) in prev and ru.diskio_read >= prev[str(pid)]:
            delta = ru.diskio_read - prev[str(pid)]
        elif prev_t and etime_s(parts[1]) < now - prev_t:
            delta = ru.diskio_read
            born += delta
        else:
            continue
        name = os.path.basename(parts[2])
        by_name[name] = by_name.get(name, 0) + delta
    state["readers_prev"], state["readers_t"] = cur, now
    if not prev_t or now <= prev_t:
        return None, None, None
    dt = now - prev_t
    top = sorted(by_name.items(), key=lambda kv: -kv[1])[:TOP_READERS]
    return ({n: round(b / dt / 1e6, 1) for n, b in top},
            round(sum(by_name.values()) / dt / 1e6, 1), round(born / dt / 1e6, 1))


def fseventsd_logs():
    """Root only: the .fseventsd log files fseventsd holds open (hex event ids)."""
    pid = run_out(["/usr/bin/pgrep", "-x", "fseventsd"]).split()
    if not pid:
        return None
    out = run_out(["/usr/sbin/lsof", "-nP", "-p", pid[0], "-Fn"])
    return sorted({ln.rsplit("/", 1)[1] for ln in out.splitlines() if ln.startswith("n") and "/.fseventsd/" in ln})


def corecaptured_proc():
    """corecaptured's pid and age (s), or None when it is not running. No root needed."""
    out = run_out(["/bin/ps", "-Ao", "pid=,etime=,comm="])
    for line in out.splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3 and os.path.basename(parts[2]) == "corecaptured":
            return {"pid": int(parts[0]), "age_s": etime_s(parts[1])}
    return None


def etime_s(etime):
    """ps's [[dd-]hh:]mm:ss as seconds."""
    days, _, rest = etime.rpartition("-")
    secs = 0
    for part in rest.split(":"):
        secs = secs * 60 + int(part)
    return secs + int(days or 0) * 86400


def maybe_incident(now, state):
    if os.geteuid() != 0 or now - state.get("last_incident", 0) < INCIDENT_COOLDOWN_S:
        return None
    os.makedirs(INCIDENTS, exist_ok=True)
    path = os.path.join(INCIDENTS, time.strftime("%Y%m%d-%H%M%S", time.gmtime(now)) + ".fs_usage.txt.gz")
    p = subprocess.run(["/usr/bin/fs_usage", "-w", "-f", "filesys", "-t", "5"], capture_output=True)
    with gzip.open(path, "wb") as fh:
        fh.write(p.stdout[: 200 * 1024 * 1024])
    state["last_incident"] = now
    return path


def main():
    os.makedirs(ROOT, exist_ok=True)
    ensure_corpus()
    try:
        with open(STATE) as fh:
            state = json.load(fh)
    except FileNotFoundError:
        state = {}
    now = time.time()
    tick = state.get("tick", 0)

    fg = probe(False, tick)
    bg = probe(True, tick)

    last_read = state.get("canary_read_at", {})
    canary = []
    for g in range(CANARY_GROUPS):
        at = last_read.get(str(g))
        if at is None:
            continue
        canary.append({"age_s": round(now - at, 1), "resident": round(resident_fraction(g), 3)})
    g = tick % CANARY_GROUPS
    rewarm(g)
    last_read[str(g)] = time.time()

    k = sysctl_ints(["vfs.vnstats.num_newvnode_calls", "vfs.vnstats.num_recycledvnodes",
                     "kern.num_vnodes", "kern.maxvnodes", "vm.loadavg"])
    d = disk_stats()
    prev = state.get("prev")
    rates = {}
    if prev and now > prev["t"]:
        dt = now - prev["t"]
        rates = {
            "new_vnodes_s": round((k["vfs.vnstats.num_newvnode_calls"] - prev["newv"]) / dt),
            "recycled_vnodes_s": round((k["vfs.vnstats.num_recycledvnodes"] - prev["recy"]) / dt),
        }
        ops = d.get("Operations (Read)", 0) - prev["rops"]
        wops = d.get("Operations (Write)", 0) - prev["wops"]
        rates["disk_read_ops_s"] = round(ops / dt)
        rates["disk_write_ops_s"] = round(wops / dt)
        rates["disk_read_mb_s"] = round((d.get("Bytes (Read)", 0) - prev["rbytes"]) / dt / 1e6, 1)
        rates["disk_read_ms_per_op"] = round((d.get("Total Time (Read)", 0) - prev["rtime"]) / ops / 1e6, 3) if ops > 0 else None
    state["prev"] = {"t": now, "newv": k["vfs.vnstats.num_newvnode_calls"], "recy": k["vfs.vnstats.num_recycledvnodes"],
                     "rops": d.get("Operations (Read)", 0), "wops": d.get("Operations (Write)", 0),
                     "rbytes": d.get("Bytes (Read)", 0), "rtime": d.get("Total Time (Read)", 0)}

    load = str(k["vm.loadavg"]).strip("{} ").split()
    max_op = max(fg["max_op"], bg["max_op"])
    rec = {
        "t": round(now, 3),
        "iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
        "fg": fg,
        "bg": bg,
        "max_op_ms": max_op,
        "stall": max_op > STALL_MS,
        "canary": canary,
        "vnodes": k["kern.num_vnodes"],
        "maxvnodes": k["kern.maxvnodes"],
        **rates,
        "load1": float(load[0]),
        "daemon_cpu": daemon_cpu(),
        "corecaptured": corecaptured_proc(),
    }
    if os.geteuid() == 0:
        top, attributed, born = disk_readers(now, state)
        rec["disk_readers_mb_s"] = top
        rec["disk_read_attributed_mb_s"] = attributed
        rec["disk_read_born_mb_s"] = born
        rec["fseventsd_logs"] = fseventsd_logs()
    if rec["stall"]:
        path = maybe_incident(now, state)
        if path:
            rec["incident"] = path
    state["tick"] = tick + 1
    state["canary_read_at"] = last_read
    with open(STATE + ".tmp", "w") as fh:
        json.dump(state, fh)
    os.replace(STATE + ".tmp", STATE)
    with open(LOG, "a") as fh:
        fh.write(json.dumps(rec, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
