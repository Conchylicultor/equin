#!/usr/bin/python3 -I
"""Who is doing the file work, without root: a per-process census beside the vnode churn.

  /usr/bin/python3 -I census.py [--seconds 300] [--out /tmp/census.json]

Once a second: every process's unix-syscall count (proc_pidinfo
PROC_PIDTASKINFO) and disk bytes read (proc_pid_rusage), and the kernel's
vfs.vnstats.num_newvnode_calls. Both are readable for the user's own processes
with no privilege; root daemons show as unreadable. Then prints, per process
kind: syscalls, disk MB read, and their correlation with new vnodes/s; and,
for the seconds with the most new vnodes, the processes reading most then.

A proxy, not an attribution: neither counter is a vnode count, and processes
living under ~1 s are missed. The exact answer is `sudo fs_usage -w -f
filesys` (the monitor's root mode). Do not run this during a measurement you
care about: the `ps` it takes each second is cheap, but not free.
"""

import argparse
import collections
import ctypes
import json
import math
import re
import subprocess
import time

libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
libc = ctypes.CDLL(None)
PROC_PIDTASKINFO = 4
RUSAGE_INFO_V2 = 2


class TaskInfo(ctypes.Structure):
    _fields_ = [(n, ctypes.c_uint64) for n in ("virt", "res", "ut", "st", "tut", "tst")] + [
        (n, ctypes.c_int32)
        for n in ("policy", "faults", "pageins", "cow", "msgs", "msgr", "mach", "unix", "csw", "thn", "thr", "prio")
    ]


class RusageV2(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [
        (n, ctypes.c_uint64)
        for n in ("ut", "st", "pkg_idle", "int_wk", "pageins", "wired", "resident", "phys", "start", "exit",
                  "child_ut", "child_st", "child_pkg", "child_int", "child_pageins", "child_elapsed",
                  "diskio_read", "diskio_write")
    ]


_mib = (ctypes.c_int * 8)()
_miblen = ctypes.c_size_t(8)
if libc.sysctlnametomib(b"vfs.vnstats.num_newvnode_calls", _mib, ctypes.byref(_miblen)) != 0:
    raise OSError("sysctlnametomib vfs.vnstats.num_newvnode_calls")


def new_vnodes():
    v, size = ctypes.c_uint64(), ctypes.c_size_t(8)
    if libc.sysctl(_mib, _miblen.value, ctypes.byref(v), ctypes.byref(size), None, 0) != 0:
        raise OSError("sysctl vfs.vnstats.num_newvnode_calls")
    return v.value


def counters(pid):
    ti, ru = TaskInfo(), RusageV2()
    ok_ti = libproc.proc_pidinfo(pid, PROC_PIDTASKINFO, ctypes.c_uint64(0), ctypes.byref(ti), ctypes.sizeof(ti)) > 0
    ok_ru = libproc.proc_pid_rusage(pid, RUSAGE_INFO_V2, ctypes.byref(ru)) == 0
    return (ti.unix if ok_ti else None, ru.diskio_read if ok_ru else None)


def sample(seconds):
    series, vn = {}, []
    t0 = time.time()
    while (now := time.time() - t0) < seconds:
        out = subprocess.run(["ps", "-Ao", "pid=,args="], capture_output=True).stdout.decode("utf-8", "replace")
        vn.append((now, new_vnodes()))
        for line in out.splitlines():
            parts = line.split(None, 1)
            if len(parts) < 2:
                continue
            pid = int(parts[0])
            sc, dr = counters(pid)
            if sc is not None or dr is not None:
                series.setdefault(f"{pid}\t{parts[1][:300]}", []).append((len(vn) - 1, sc, dr))
        time.sleep(max(0.0, 1 - (time.time() - t0 - now)))
    return {"vn": vn, "series": series}


def kind(args):
    args = re.sub(r"(att|conv|task|build)-[0-9a-z-]+", "<id>", args)
    named = re.search(r"· (\w[\w-]*) ·", args)  # packages/process-name: `equin · <kind> · <id>`
    if named:
        verb = re.search(r"index\.ts (\S+)", args)
        return "equin:" + named.group(1) + (":" + verb.group(1) if verb else "")
    words = args.split()
    base = words[0].split("/")[-1]
    if base == "git":
        sub = [w for w in words[1:] if not w.startswith("-") and "=" not in w and not w.startswith("/")]
        return "git " + (sub[0] if sub else "?")
    if base in ("bun", "node") and len(words) > 1:
        return f"{base} {'/'.join(words[1].split('/')[-2:])}"
    return base[:50]


def corr(xs, ys):
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy) if sx and sy else 0.0


def report(data, top):
    vn = data["vn"]
    n = len(vn) - 1
    if n < 2:
        raise SystemExit("too short a window")
    rate = [(vn[i + 1][1] - vn[i][1]) / (vn[i + 1][0] - vn[i][0]) for i in range(n)]
    sc = collections.defaultdict(lambda: [0.0] * n)
    mb = collections.defaultdict(lambda: [0.0] * n)
    per_proc_mb = collections.defaultdict(lambda: [0.0] * n)
    for key, points in data["series"].items():
        k = kind(key.split("\t", 1)[1])
        for (i, s0, d0), (_, s1, d1) in zip(points, points[1:]):
            if i >= n:
                continue
            if s0 is not None and s1 is not None:
                sc[k][i] += max(0, s1 - s0)
            if d0 is not None and d1 is not None:
                mb[k][i] += max(0, d1 - d0) / 1e6
                per_proc_mb[key][i] += max(0, d1 - d0) / 1e6
    span = vn[-1][0] - vn[0][0]
    print(f"window {span:.0f} s: new vnodes {(vn[-1][1] - vn[0][1]) / span:.0f}/s (max {max(rate):.0f}/s in one sample)")
    print(f"\n{'syscalls':>10} {'r(vn)':>6} {'disk MB':>8} {'r(vn)':>6}  kind")
    for k in sorted(sc, key=lambda k: -sum(sc[k]))[:top]:
        print(f"{sum(sc[k]):>10.0f} {corr(sc[k], rate):>6.2f} {sum(mb[k]):>8.1f} {corr(mb[k], rate):>6.2f}  {k[:90]}")
    print("\nseconds with the most new vnodes, and who read most then:")
    for i in sorted(range(n), key=lambda i: -rate[i])[:10]:
        print(f"  t={vn[i][0]:.0f}s {rate[i]:.0f} vn/s")
        for v, key in sorted(((per_proc_mb[k][i], k) for k in per_proc_mb), reverse=True)[:4]:
            if v >= 0.5:
                pid, args = key.split("\t", 1)
                print(f"    {v:6.1f} MB  {pid:>6} {args[:110]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=300)
    ap.add_argument("--out", help="also write the raw samples here (JSON)")
    ap.add_argument("--top", type=int, default=30)
    a = ap.parse_args()
    data = sample(a.seconds)
    if a.out:
        with open(a.out, "w") as f:
            json.dump(data, f)
    report(data, a.top)


if __name__ == "__main__":
    main()
