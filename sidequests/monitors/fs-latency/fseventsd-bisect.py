#!/usr/bin/python3 -I
"""Which client makes fseventsd replay its event history in a loop? Root only.

    sudo /usr/bin/python3 -I ~/.equin/logs/monitors/fs-latency-src/fseventsd-bisect.py [--fseventsd]

A replay shows as fseventsd holding open a `.fseventsd` log file far behind the
one being written (the newest file in the directory). This script:

1. Baseline (one cycle, WINDOW_S): confirms the replay and dates it: the oldest
   log file, and the log files the replay starts and ends in, with their mtimes.
   Meanwhile it turns on fseventsd's debug logging and records `log stream` for
   the window. The debug log may name the client by itself.
2. Restarts each suspect in turn (SUSPECTS: daemons that began at the 2026-11-03
   01:28 UTC onset, when syspolicyd crashed), and watches another WINDOW_S. The
   first suspect after which no replay is seen is the client. launchd respawns
   every one of them.
3. With --fseventsd, as a last resort, restarts fseventsd itself. That proves
   the mechanism but names no client.

Writes a JSON summary (and the debug log stream) under
~/.equin/logs/monitors/captures/. Read-only apart from the restarts.
"""
import json
import os
import subprocess
import sys
import time

FSEVENTS_DIR = "/System/Volumes/Data/.fseventsd"
# The longest replay cycle observed was 339 s (median 242 s).
WINDOW_S = 360
SAMPLE_S = 5
SETTLE_S = 20
# "Behind" = this many event ids before the live log (~1-4k ids/s here: hours).
BEHIND_IDS = 0x08000000
SUSPECTS = ["XprotectService", "XProtectBridgeService", "syspolicyd"]
HOME = os.environ.get("MONITOR_HOME") or os.path.expanduser("~" + os.environ.get("SUDO_USER", ""))
OUT = os.path.join(HOME, ".equin/logs/monitors/captures")


def run_out(argv):
    return subprocess.run(argv, capture_output=True).stdout.decode("utf-8", "replace")


def log_files():
    """{event id: mtime} of every log file in .fseventsd."""
    files = {}
    for name in os.listdir(FSEVENTS_DIR):
        try:
            files[int(name, 16)] = os.stat(os.path.join(FSEVENTS_DIR, name)).st_mtime
        except ValueError:
            continue
    return files


def fseventsd_pid():
    pids = run_out(["/usr/bin/pgrep", "-x", "fseventsd"]).split()
    return pids[0] if pids else None


def open_logs(pid):
    out = run_out(["/usr/sbin/lsof", "-nP", "-p", pid, "-Fn"])
    ids = set()
    for ln in out.splitlines():
        if ln.startswith("n") and "/.fseventsd/" in ln:
            try:
                ids.add(int(ln.rsplit("/", 1)[1], 16))
            except ValueError:
                continue
    return ids


def cpu(pid):
    out = run_out(["/bin/ps", "-o", "pcpu=", "-p", pid]).strip()
    return float(out) if out else None


def iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def watch(label, seconds):
    """Sample fseventsd's open log files; the replayed ids seen behind the live log."""
    behind, cpus, end = [], [], time.time() + seconds
    while time.time() < end:
        pid = fseventsd_pid()
        if pid:
            head = max(log_files())
            behind += [i for i in open_logs(pid) if i < head - BEHIND_IDS]
            c = cpu(pid)
            if c is not None:
                cpus.append(c)
        time.sleep(SAMPLE_S)
    res = {
        "label": label,
        "replaying": bool(behind),
        "replay_min": hex(min(behind)) if behind else None,
        "replay_max": hex(max(behind)) if behind else None,
        "fseventsd_cpu_avg": round(sum(cpus) / len(cpus), 1) if cpus else None,
    }
    print(json.dumps(res), flush=True)
    return res


def date_ids(ids, files):
    """Each id's log file (the first file name at or past it) and that file's mtime."""
    names = sorted(files)
    out = {}
    for i in ids:
        f = next((n for n in names if n >= i), names[-1])
        out[hex(i)] = {"file": f"{f:016x}", "mtime": iso(files[f])}
    return out


def main():
    if os.geteuid() != 0:
        sys.exit("run with sudo: fseventsd's log directory and clients are root-only")
    os.makedirs(OUT, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    summary = {"started": iso(time.time()), "steps": []}

    files = log_files()
    oldest, head = min(files), max(files)
    summary["logs"] = {"count": len(files), "oldest": f"{oldest:016x}", "oldest_mtime": iso(files[oldest]),
                       "head": f"{head:016x}"}
    print(json.dumps(summary["logs"]), flush=True)

    stream_path = os.path.join(OUT, f"fseventsd-debug-{stamp}.log")
    subprocess.run(["/usr/bin/log", "config", "--subsystem", "com.apple.fsevents", "--mode", "level:debug"], check=True)
    with open(stream_path, "wb") as fh:
        stream = subprocess.Popen(["/usr/bin/log", "stream", "--level", "debug", "--style", "compact",
                                   "--predicate", 'process == "fseventsd" OR subsystem == "com.apple.fsevents"'],
                                  stdout=fh, stderr=subprocess.STDOUT)
        try:
            base = watch("baseline", WINDOW_S)
        finally:
            stream.terminate()
            stream.wait()
            subprocess.run(["/usr/bin/log", "config", "--subsystem", "com.apple.fsevents", "--reset"], check=True)
    summary["debug_log"] = stream_path
    summary["steps"].append(base)
    if base["replaying"]:
        files = log_files()
        summary["replay_dated"] = date_ids([int(base["replay_min"], 16), int(base["replay_max"], 16)], files)
    else:
        summary["verdict"] = "no replay during the baseline: nothing to bisect"

    candidates = SUSPECTS + (["fseventsd"] if "--fseventsd" in sys.argv else [])
    for name in candidates if base["replaying"] else []:
        killed = subprocess.run(["/usr/bin/killall", name], capture_output=True).returncode == 0
        time.sleep(SETTLE_S)
        step = watch(f"after restarting {name}" if killed else f"{name} (not running)", WINDOW_S)
        step["killed"] = killed
        summary["steps"].append(step)
        if killed and not step["replaying"]:
            summary["verdict"] = f"the replay stopped after restarting {name}"
            break
    else:
        summary.setdefault("verdict", "the replay survived every restart: read the debug log for the client")

    path = os.path.join(OUT, f"fseventsd-bisect-{stamp}.json")
    with open(path, "w") as fh:
        json.dump(summary, fh, indent=2)
    print(summary["verdict"])
    print(f"summary: {path}\ndebug log: {stream_path}")


if __name__ == "__main__":
    main()
